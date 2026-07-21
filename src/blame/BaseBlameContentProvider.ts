import * as vscode from "vscode";
import { SvnClient } from "../core/SvnClient";

const BASE_BLAME_SCHEME = "svn-atlas-base-blame";
const MAX_AUTHOR_WIDTH = 24;

export interface BaseBlameLine {
  readonly lineNumber: number;
  readonly revision: string;
  readonly author: string;
  readonly date: string;
}

export interface BaseBlameHoverInfo extends BaseBlameLine {
  readonly baseLineNumber: number;
}

interface BaseBlameDocument {
  readonly content: string;
  readonly entries: readonly (BaseBlameLine | undefined)[];
}

interface CachedDiff {
  readonly documentVersion: number;
  readonly content: string;
}

/**
 * Provides full BASE blame documents and per-line hover metadata.
 *
 * SVN stores pristine BASE contents locally, but reconstructing per-line
 * history can require a repository request. The command always passes
 * `-r BASE`; results are cached until an explicit local BASE refresh.
 */
export class BaseBlameContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  public static readonly scheme = BASE_BLAME_SCHEME;

  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly documents = new Map<string, BaseBlameDocument>();
  private readonly diffs = new Map<string, CachedDiff>();
  private readonly pendingLoads = new Map<string, Promise<BaseBlameDocument>>();
  private readonly pendingDiffs = new Map<string, Promise<CachedDiff>>();
  private readonly knownResources = new Map<string, vscode.Uri>();
  private readonly workingCopyRoots = new Map<string, string>();
  private readonly registration: vscode.Disposable;

  public readonly onDidChange = this.changeEmitter.event;

  public constructor(
    private readonly svn: SvnClient,
    private readonly output: vscode.OutputChannel,
  ) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(BASE_BLAME_SCHEME, this);
  }

  public async open(resource: vscode.Uri): Promise<vscode.Uri> {
    const blameUri = this.toBlameUri(resource);
    await this.load(resource);
    return blameUri;
  }

  public async isWorkingCopy(resource: vscode.Uri): Promise<boolean> {
    if (resource.scheme !== "file") {
      return false;
    }

    const normalizedFile = normalizePath(resource.fsPath);
    for (const normalizedRoot of this.workingCopyRoots.keys()) {
      if (normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`)) {
        return true;
      }
    }

    const root = await this.svn.getWorkingCopyRoot(resource);
    if (!root) {
      return false;
    }

    this.workingCopyRoots.set(normalizePath(root), root);
    return true;
  }

  public async getHoverInfo(
    document: vscode.TextDocument,
    line: number,
    token: vscode.CancellationToken,
  ): Promise<BaseBlameHoverInfo | undefined> {
    if (!(await this.isWorkingCopy(document.uri)) || document.isDirty) {
      return undefined;
    }
    if (token.isCancellationRequested) {
      return undefined;
    }

    try {
      const [baseBlame, baseLineNumber] = await Promise.all([
        this.load(document.uri),
        this.getBaseLineNumber(document, line + 1),
      ]);
      if (token.isCancellationRequested || baseLineNumber === undefined) {
        return undefined;
      }

      const entry = baseBlame.entries[baseLineNumber - 1];
      return entry ? { ...entry, baseLineNumber } : undefined;
    } catch {
      // Hover requests should remain unobtrusive. Detailed failures are logged
      // by the loader and surfaced by the explicit full-document command.
      return undefined;
    }
  }

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const resource = this.knownResources.get(uri.toString());
    if (!resource) {
      return "SVN Atlas could not resolve the source file for this BASE blame view.";
    }

    return (await this.load(resource)).content;
  }

  public clear(): void {
    this.documents.clear();
    this.diffs.clear();
    this.pendingDiffs.clear();
    for (const uri of this.knownResources.keys()) {
      this.changeEmitter.fire(vscode.Uri.parse(uri));
    }
  }

  public dispose(): void {
    this.registration.dispose();
    this.changeEmitter.dispose();
    this.documents.clear();
    this.diffs.clear();
    this.pendingLoads.clear();
    this.pendingDiffs.clear();
    this.knownResources.clear();
    this.workingCopyRoots.clear();
  }

  private toBlameUri(resource: vscode.Uri): vscode.Uri {
    const blameUri = vscode.Uri.from({ scheme: BASE_BLAME_SCHEME, path: resource.path });
    this.knownResources.set(blameUri.toString(), resource);
    return blameUri;
  }

  private async load(resource: vscode.Uri): Promise<BaseBlameDocument> {
    const cacheKey = resource.toString();
    const cached = this.documents.get(cacheKey);
    if (cached) {
      return cached;
    }

    const pending = this.pendingLoads.get(cacheKey);
    if (pending) {
      return pending;
    }

    const load = this.loadUncached(resource);
    this.pendingLoads.set(cacheKey, load);
    try {
      const document = await load;
      this.documents.set(cacheKey, document);
      return document;
    } finally {
      this.pendingLoads.delete(cacheKey);
    }
  }

  private async loadUncached(resource: vscode.Uri): Promise<BaseBlameDocument> {
    try {
      const [baseContent, blameXml] = await Promise.all([
        this.svn.readBase(resource),
        this.svn.readBaseBlame(resource),
      ]);
      return createBlameDocument(resource, baseContent, blameXml);
    } catch (error) {
      const message = formatError(error);
      this.output.appendLine(`Unable to read BASE blame for ${resource.fsPath}: ${message}`);
      throw new Error(`SVN Atlas could not read BASE blame for ${resource.fsPath}: ${message}`);
    }
  }

  private async getBaseLineNumber(document: vscode.TextDocument, workingLineNumber: number): Promise<number | undefined> {
    const cacheKey = document.uri.toString();
    let diff = this.diffs.get(cacheKey);
    if (!diff || diff.documentVersion !== document.version) {
      try {
        diff = await this.loadDiff(document);
        this.diffs.set(cacheKey, diff);
      } catch (error) {
        this.output.appendLine(`Unable to map BASE blame for ${document.uri.fsPath}: ${formatError(error)}`);
        return undefined;
      }
    }

    return mapWorkingLineToBaseLine(diff.content, workingLineNumber);
  }

  private async loadDiff(document: vscode.TextDocument): Promise<CachedDiff> {
    const cacheKey = document.uri.toString();
    const pending = this.pendingDiffs.get(cacheKey);
    if (pending) {
      return pending;
    }

    const documentVersion = document.version;
    const load = this.svn.readBaseDiff(document.uri).then((content) => ({ documentVersion, content }));
    this.pendingDiffs.set(cacheKey, load);
    try {
      return await load;
    } finally {
      this.pendingDiffs.delete(cacheKey);
    }
  }
}

function createBlameDocument(resource: vscode.Uri, baseContent: string, blameXml: string): BaseBlameDocument {
  const entries = parseBlameXml(blameXml);
  const revisionWidth = Math.max(8, ...entries.flatMap((entry) => entry ? [entry.revision.length] : []));
  const lines = splitLines(baseContent);
  const result = [
    `# SVN Atlas BASE blame: ${resource.fsPath}`,
    "# revision author                   date       | BASE content",
    "# History is resolved by SVN for the working copy's BASE revision.",
  ];

  for (let index = 0; index < lines.length; index += 1) {
    const entry = entries[index];
    const revision = entry?.revision ?? "-";
    const author = truncate(entry?.author ?? "-", MAX_AUTHOR_WIDTH);
    const date = entry?.date ?? "-";
    result.push(`${revision.padStart(revisionWidth)} ${author.padEnd(MAX_AUTHOR_WIDTH)} ${date.padEnd(10)} | ${lines[index]}`);
  }

  return { content: result.join("\n"), entries };
}

function parseBlameXml(xml: string): readonly (BaseBlameLine | undefined)[] {
  const entries: (BaseBlameLine | undefined)[] = [];
  const entryPattern = /<entry\b[^>]*\bline-number="(\d+)"[^>]*>([\s\S]*?)<\/entry>/g;

  for (const match of xml.matchAll(entryPattern)) {
    const lineNumber = Number.parseInt(match[1], 10);
    const body = match[2];
    const revision = body.match(/<commit\b[^>]*\brevision="(\d+)"[^>]*>/)?.[1] ?? "-";
    const author = decodeXml(body.match(/<author>([\s\S]*?)<\/author>/)?.[1] ?? "-");
    const timestamp = decodeXml(body.match(/<date>([\s\S]*?)<\/date>/)?.[1] ?? "");
    entries[lineNumber - 1] = {
      lineNumber,
      revision,
      author,
      date: timestamp.slice(0, 10) || "-",
    };
  }

  return entries;
}

function mapWorkingLineToBaseLine(diff: string, workingLineNumber: number): number | undefined {
  let baseLineNumber = 1;
  let currentWorkingLineNumber = 1;
  let removedLines: number[] = [];
  let inHunk = false;

  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      const nextBaseLine = Number.parseInt(hunk[1], 10);
      const nextWorkingLine = Number.parseInt(hunk[2], 10);
      if (workingLineNumber < nextWorkingLine) {
        return baseLineNumber + workingLineNumber - currentWorkingLineNumber;
      }

      baseLineNumber = nextBaseLine;
      currentWorkingLineNumber = nextWorkingLine;
      removedLines = [];
      inHunk = true;
      continue;
    }

    if (!inHunk || line.length === 0 || line.startsWith("\\")) {
      continue;
    }

    switch (line[0]) {
      case " ":
        if (workingLineNumber === currentWorkingLineNumber) {
          return baseLineNumber;
        }
        baseLineNumber += 1;
        currentWorkingLineNumber += 1;
        removedLines = [];
        break;
      case "-":
        removedLines.push(baseLineNumber);
        baseLineNumber += 1;
        break;
      case "+": {
        const replacedBaseLine = removedLines.shift();
        if (workingLineNumber === currentWorkingLineNumber) {
          return replacedBaseLine;
        }
        currentWorkingLineNumber += 1;
        break;
      }
      default:
        break;
    }
  }

  return baseLineNumber + workingLineNumber - currentWorkingLineNumber;
}

function splitLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);|&#(\d+);|&#x([\da-fA-F]+);/g, (entity, decimal, hexadecimal) => {
    if (decimal) {
      return String.fromCodePoint(Number.parseInt(decimal, 10));
    }
    if (hexadecimal) {
      return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
    }
    return {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": "\"",
      "&apos;": "'",
    }[entity] ?? entity;
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}
