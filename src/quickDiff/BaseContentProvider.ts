import * as vscode from "vscode";
import { SvnClient } from "../core/SvnClient";

const BASE_SCHEME = "svn-atlas-base";

export interface QuickDiffSettings {
  readonly cacheSize: number;
  readonly maxFileSizeBytes: number | undefined;
}

/**
 * Provides pristine SVN BASE file contents to VS Code's Quick Diff API.
 *
 * Cached contents are keyed by original file URI. They are invalidated only
 * after an SVN working-copy update or an explicit refresh, never by a broad
 * workspace status scan.
 */
export class BaseContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  public static readonly scheme = BASE_SCHEME;

  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly baseContents = new Map<string, string>();
  private readonly knownResources = new Map<string, vscode.Uri>();
  private readonly registration: vscode.Disposable;

  public readonly onDidChange = this.changeEmitter.event;

  public constructor(
    private readonly svn: SvnClient,
    private readonly getSettings: () => QuickDiffSettings,
    private readonly output: vscode.OutputChannel,
  ) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, this);
  }

  public toBaseUri(resource: vscode.Uri): vscode.Uri {
    const baseUri = vscode.Uri.from({ scheme: BASE_SCHEME, path: resource.path });
    this.knownResources.set(baseUri.toString(), resource);
    return baseUri;
  }

  /** Ensures a valid local BASE can be supplied before Quick Diff is enabled. */
  public async prepare(resource: vscode.Uri): Promise<boolean> {
    return (await this.loadBase(resource, false)) !== undefined;
  }

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const original = this.knownResources.get(uri.toString()) ?? vscode.Uri.file(uri.fsPath);
    const content = await this.loadBase(original, false);
    return content ?? "";
  }

  public async refreshAll(): Promise<number> {
    return this.refreshResources([...this.knownResources.values()]);
  }

  public async refreshUnder(workingCopyRoot: string): Promise<number> {
    const resources = [...this.knownResources.values()].filter((resource) => isWithinRoot(resource.fsPath, workingCopyRoot));
    return this.refreshResources(resources);
  }

  public clear(): void {
    this.baseContents.clear();
  }

  public dispose(): void {
    this.registration.dispose();
    this.changeEmitter.dispose();
    this.baseContents.clear();
    this.knownResources.clear();
  }

  private async refreshResources(resources: readonly vscode.Uri[]): Promise<number> {
    let refreshed = 0;

    for (const resource of resources) {
      const content = await this.loadBase(resource, true);
      if (content !== undefined) {
        this.changeEmitter.fire(this.toBaseUri(resource));
        refreshed += 1;
      }
    }

    return refreshed;
  }

  private async loadBase(resource: vscode.Uri, forceReload: boolean): Promise<string | undefined> {
    const cacheKey = resource.toString();
    const cached = this.baseContents.get(cacheKey);
    if (!forceReload && cached !== undefined) {
      this.touch(cacheKey, cached);
      return cached;
    }

    if (!(await this.isEligible(resource))) {
      return undefined;
    }

    try {
      const content = await this.svn.readBase(resource);
      this.touch(cacheKey, content);
      return content;
    } catch (error) {
      this.output.appendLine(`Unable to read local BASE for ${resource.fsPath}: ${formatError(error)}`);
      return cached;
    }
  }

  private async isEligible(resource: vscode.Uri): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(resource);
      if ((stat.type & vscode.FileType.File) === 0) {
        return false;
      }

      const sizeLimit = this.getSettings().maxFileSizeBytes;
      if (sizeLimit !== undefined && stat.size > sizeLimit) {
        this.output.appendLine(`Skipping Quick Diff for large file: ${resource.fsPath}`);
        return false;
      }

      return true;
    } catch (error) {
      this.output.appendLine(`Unable to inspect ${resource.fsPath}: ${formatError(error)}`);
      return false;
    }
  }

  private touch(cacheKey: string, content: string): void {
    this.baseContents.delete(cacheKey);
    this.baseContents.set(cacheKey, content);

    const cacheSize = this.getSettings().cacheSize;
    while (this.baseContents.size > cacheSize) {
      const oldestKey = this.baseContents.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.baseContents.delete(oldestKey);
    }
  }
}

function isWithinRoot(filePath: string, rootPath: string): boolean {
  const normalizedFile = normalizePath(filePath);
  const normalizedRoot = normalizePath(rootPath);
  return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
