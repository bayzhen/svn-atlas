import * as vscode from "vscode";
import { SvnClient } from "../core/SvnClient";
import { BaseContentProvider, QuickDiffSettings } from "./BaseContentProvider";

/**
 * Connects the local SVN BASE provider to VS Code's gutter decorations.
 *
 * No resource groups or status polling are created here. This intentionally
 * keeps the extension-host work proportional to files a developer opens,
 * rather than to the size of the entire SVN checkout.
 */
export class LocalBaseQuickDiff implements vscode.Disposable {
  private readonly sourceControl: vscode.SourceControl;
  private readonly provider: BaseContentProvider;
  private readonly workingCopyRoots = new Map<string, string>();
  private readonly workingCopyWatchers = new Map<string, vscode.Disposable>();
  private readonly subscriptions: vscode.Disposable[] = [];

  public constructor(
    private readonly svn: SvnClient,
    private readonly output: vscode.OutputChannel,
  ) {
    // VS Code selects Quick Diff providers by their SCM root. A provider with
    // no root is not considered for file resources, even if it is active.
    // The first workspace folder is the safe, local-only scope for v0.1.
    this.sourceControl = vscode.scm.createSourceControl(
      "svn-atlas",
      "SVN Atlas",
      vscode.workspace.workspaceFolders?.[0]?.uri,
    );
    this.provider = new BaseContentProvider(svn, () => this.getSettings(), output);
    this.sourceControl.inputBox.enabled = false;
    this.sourceControl.inputBox.visible = false;
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: (resource, token) => this.provideOriginalResource(resource, token),
    };

    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("svnAtlas")) {
          this.workingCopyRoots.clear();
          this.provider.clear();
          void this.refreshAll();
        }
      }),
    );
  }

  public async refreshAll(): Promise<number> {
    const refreshed = await this.provider.refreshAll();
    this.output.appendLine(`Refreshed local BASE for ${refreshed} open file(s).`);
    return refreshed;
  }

  public dispose(): void {
    this.sourceControl.dispose();
    this.provider.dispose();
    this.workingCopyRoots.clear();
    for (const watcher of this.workingCopyWatchers.values()) {
      watcher.dispose();
    }
    this.workingCopyWatchers.clear();
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
  }

  private async provideOriginalResource(
    resource: vscode.Uri,
    token: vscode.CancellationToken,
  ): Promise<vscode.Uri | undefined> {
    if (!this.isEnabled(resource) || resource.scheme !== "file" || token.isCancellationRequested) {
      return undefined;
    }

    const workingCopyRoot = await this.getWorkingCopyRoot(resource);
    if (!workingCopyRoot || token.isCancellationRequested) {
      return undefined;
    }

    this.ensureWorkingCopyWatcher(workingCopyRoot);
    if (!(await this.provider.prepare(resource)) || token.isCancellationRequested) {
      return undefined;
    }

    return this.provider.toBaseUri(resource);
  }

  private async getWorkingCopyRoot(resource: vscode.Uri): Promise<string | undefined> {
    const cached = this.findCachedWorkingCopyRoot(resource.fsPath);
    if (cached) {
      return cached;
    }

    const root = await this.svn.getWorkingCopyRoot(resource);
    if (root) {
      this.workingCopyRoots.set(normalizePath(root), root);
    }
    return root;
  }

  private findCachedWorkingCopyRoot(filePath: string): string | undefined {
    const normalizedFile = normalizePath(filePath);
    let nearestRoot: string | undefined;

    for (const [normalizedRoot, root] of this.workingCopyRoots) {
      if (
        (normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`)) &&
        (!nearestRoot || normalizedRoot.length > normalizePath(nearestRoot).length)
      ) {
        nearestRoot = root;
      }
    }

    return nearestRoot;
  }

  private ensureWorkingCopyWatcher(workingCopyRoot: string): void {
    const watcherKey = normalizePath(workingCopyRoot);
    if (this.workingCopyWatchers.has(watcherKey)) {
      return;
    }

    const rootUri = vscode.Uri.file(workingCopyRoot);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(rootUri, ".svn/wc.db"));
    const refresh = () => {
      void this.refreshAfterWorkingCopyChange(workingCopyRoot);
    };

    this.subscriptions.push(watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
    this.workingCopyWatchers.set(watcherKey, watcher);
  }

  private async refreshAfterWorkingCopyChange(workingCopyRoot: string): Promise<void> {
    const refreshed = await this.provider.refreshUnder(workingCopyRoot);
    if (refreshed > 0) {
      this.output.appendLine(`SVN working copy changed; refreshed ${refreshed} local BASE file(s).`);
    }
  }

  private isEnabled(resource: vscode.Uri): boolean {
    return vscode.workspace.getConfiguration("svnAtlas", resource).get<boolean>("quickDiff.enabled", true);
  }

  private getSettings(): QuickDiffSettings {
    const configuration = vscode.workspace.getConfiguration("svnAtlas");
    const cacheSize = configuration.get<number>("quickDiff.cacheSize", 128);
    const maxCacheSizeMB = configuration.get<number>("quickDiff.maxCacheSizeMB", 64);
    const maxFileSizeMB = configuration.get<number>("quickDiff.maxFileSizeMB", 16);

    return {
      cacheSize: Math.max(1, Math.floor(cacheSize)),
      maxCacheSizeBytes: Math.max(1, maxCacheSizeMB) * 1024 * 1024,
      maxFileSizeBytes: maxFileSizeMB > 0 ? maxFileSizeMB * 1024 * 1024 : undefined,
    };
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}
