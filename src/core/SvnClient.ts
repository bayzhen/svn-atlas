import { execFile } from "node:child_process";
import * as vscode from "vscode";

const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024 * 1024;

export class SvnCommandError extends Error {
  public constructor(
    public readonly args: readonly string[],
    public readonly stderr: string,
    cause: Error,
  ) {
    super(`svn ${args.join(" ")} failed: ${stderr || cause.message}`);
    this.name = "SvnCommandError";
    this.cause = cause;
  }
}
/**
 * A deliberately small, local-only SVN command boundary.
 *
 * The initial Atlas feature set never calls status -u, log, or any other
 * command that needs the repository server. Both commands below are served
 * from the working copy metadata and pristine text base.
 */
export class SvnClient {
  public constructor(private readonly getExecutablePath: () => string) {}

  public async getWorkingCopyRoot(resource: vscode.Uri): Promise<string | undefined> {
    try {
      const output = await this.run(["info", "--show-item", "wc-root", "--", resource.fsPath]);
      const root = output.toString("utf8").trim();
      return root || undefined;
    } catch {
      return undefined;
    }
  }

  public async readBase(resource: vscode.Uri): Promise<string> {
    const output = await this.run(["cat", "-r", "BASE", "--", resource.fsPath]);
    return output.toString("utf8");
  }

  private run(args: string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      execFile(
        this.getExecutablePath(),
        args,
        {
          encoding: "buffer",
          maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (error) {
            const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : String(stderr).trim();
            reject(new SvnCommandError(args, stderrText, error));
            return;
          }

          resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
        },
      );
    });
  }
}
