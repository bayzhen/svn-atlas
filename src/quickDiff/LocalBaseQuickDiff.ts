import * as vscode from "vscode";
import { SvnClient } from "../core/SvnClient";
import { BaseContentProvider, QuickDiffSettings } from "./BaseContentProvider";

const ROOT_CACHE_TTL_MS = 15_000;

interface RootCacheEntry {
  readonly expiresAt: number;
  readonly root: string | undefined;
}

/**
 * Connects the local SVN BASE provider to VS Code's gutter decorations.
 *
 * No resource groups or status polling are created here. This intentionally
 * keeps the extension-host work proportional to files a developer opens,
 * rather than to the size of the entire SVN checkout.
 */
export class LocalBaseQuickDiff implements vscode.Disposable {
  private readonly sourceControl = vscode.scm.createSourceControl("svn-atlas", "SVN Atlas");
  private readonly provider: BaseContentProvider;
  private readonly rootCache = new Map<string, RootCacheEntry>();
  private readonly workingCopyWatchers = new Map<string, vscode.Disposable>();
  private readonly subscriptions: vscode.Disposable[] = [];

  public constructor(
    private readonly svn: SvnClient,
    private readonly output: vscode.OutputChannel,
  ) {
    this.provider = new BaseContentProvider(svn, () => this.getSettings(), output);
    this.sourceControl.inputBox.enabled = false;
    this.sourceControl.inputBox.visible = false;
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: (resource, token) => this.provideOriginalResource(resource, token),
    };

    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("svnAtlas")) {
          this.rootCache.clear();
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
    this.rootCache.clear();
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
    const cacheKey = resource.toString();
    const cached = this.rootCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.root;
    }

    const root = await this.svn.getWorkingCopyRoot(resource);
    this.rootCache.set(cacheKey, { root, expiresAt: Date.now() + ROOT_CACHE_TTL_MS });
    return root;
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
    const cacheSize = configuration.get<number>("quickDiff.cacheSize", 32);
    const maxFileSizeMB = configuration.get<number>("quickDiff.maxFileSizeMB", 5);

    return {
      cacheSize: Math.max(1, Math.floor(cacheSize)),
      maxFileSizeBytes: maxFileSizeMB > 0 ? maxFileSizeMB * 1024 * 1024 : undefined,
    };
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}
