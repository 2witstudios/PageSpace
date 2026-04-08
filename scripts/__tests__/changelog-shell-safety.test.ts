import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFileSync, execSync } from "child_process";

vi.mock("child_process", () => ({
  execSync: vi.fn(() => ""),
  execFileSync: vi.fn(() => ""),
}));

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExecSync = vi.mocked(execSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("execGit helper", () => {
  it("calls execFileSync with 'git' and array args, not execSync", async () => {
    const { execGit } = await import("../changelog/git-exec");

    execGit(["log", "--oneline"]);

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["log", "--oneline"],
      expect.objectContaining({ encoding: "utf8" })
    );
    expect(mockedExecSync).not.toHaveBeenCalled();
  });

  it("passes shell metacharacters as literal array elements, not shell-interpolated", async () => {
    const { execGit } = await import("../changelog/git-exec");
    const maliciousFilename = '"; echo pwned; echo "';

    execGit(["show", `abc123^:${maliciousFilename}`]);

    const callArgs = mockedExecFileSync.mock.calls[0];
    expect(callArgs[0]).toBe("git");
    expect(callArgs[1]).toEqual(["show", 'abc123^:"; echo pwned; echo "']);
    // The malicious string is a single array element — no shell will interpret it
  });

  it("returns empty string on error (matches existing exec() behavior)", async () => {
    const { execGit } = await import("../changelog/git-exec");
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("Command failed");
    });

    const result = execGit(["show", "nonexistent"]);

    expect(result).toBe("");
  });

  it("suppresses stderr via stdio option", async () => {
    const { execGit } = await import("../changelog/git-exec");

    execGit(["log"]);

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      expect.any(Array),
      expect.objectContaining({
        stdio: ["pipe", "pipe", "ignore"],
      })
    );
  });
});

describe("detect-abandoned-approaches: getLinesAtCommit", () => {
  it("uses execFileSync (not execSync) for git show with file path", async () => {
    const { getLinesAtCommit } = await import(
      "../changelog/detect-abandoned-approaches"
    );

    getLinesAtCommit("abc1234", "src/safe-file.ts");

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["show", "abc1234^:src/safe-file.ts"],
      expect.objectContaining({ encoding: "utf8" })
    );
    // execSync must NOT be called for commands with variable interpolation
  });

  it("does not execute shell metacharacters in filenames", async () => {
    const { getLinesAtCommit } = await import(
      "../changelog/detect-abandoned-approaches"
    );
    const malicious = '"; rm -rf /; echo "';

    getLinesAtCommit("abc1234", malicious);

    // Verify the malicious filename is passed as a literal arg, not shell-interpolated
    const gitCalls = mockedExecFileSync.mock.calls.filter(
      (call) => call[0] === "git"
    );
    expect(gitCalls.length).toBeGreaterThan(0);
    const showCall = gitCalls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[1][0] === "show"
    );
    expect(showCall).toBeDefined();
    expect(showCall![1]).toEqual(["show", 'abc1234^:"; rm -rf /; echo "']);
  });

  it("handles errors gracefully without crashing", async () => {
    const { getLinesAtCommit } = await import(
      "../changelog/detect-abandoned-approaches"
    );
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("fatal: path not found");
    });

    // execGit catches the error and returns "" → "".split("\n") = [""] → length 1
    // The important thing is it doesn't crash or execute shell commands
    const result = getLinesAtCommit("abc1234", "nonexistent.ts");

    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

describe("detect-abandoned-approaches: getCommitBody", () => {
  it("uses execFileSync (not execSync) for git log with commit hash", async () => {
    mockedExecFileSync.mockReturnValue("commit body text\n");
    const { getCommitBody } = await import(
      "../changelog/detect-abandoned-approaches"
    );

    getCommitBody("abc1234");

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["log", "-1", "--format=%b", "abc1234"],
      expect.objectContaining({ encoding: "utf8" })
    );
  });
});

describe("track-file-evolution: getFileHistory", () => {
  it("uses execFileSync (not execSync) for git log with file path", async () => {
    const { getFileHistory } = await import(
      "../changelog/track-file-evolution"
    );

    getFileHistory("src/safe-file.ts");

    // Both git log calls should go through execFileSync
    const gitCalls = mockedExecFileSync.mock.calls.filter(
      (call) => call[0] === "git"
    );
    expect(gitCalls.length).toBeGreaterThanOrEqual(2);

    // First call: git log --follow ... -- filePath
    const firstCall = gitCalls[0];
    expect(firstCall[1]).toContain("--follow");
    expect(firstCall[1]).toContain("src/safe-file.ts");

    // Second call: git log --follow --diff-filter=AD ... -- filePath
    const secondCall = gitCalls[1];
    expect(secondCall[1]).toContain("--diff-filter=AD");
    expect(secondCall[1]).toContain("src/safe-file.ts");
  });

  it("does not execute shell metacharacters in file paths", async () => {
    const { getFileHistory } = await import(
      "../changelog/track-file-evolution"
    );
    const malicious = '$(rm -rf /)';

    getFileHistory(malicious);

    // Verify the malicious path is passed as a literal arg
    const gitCalls = mockedExecFileSync.mock.calls.filter(
      (call) => call[0] === "git"
    );
    for (const call of gitCalls) {
      const args = call[1] as string[];
      // The filePath should appear as the last array element (after "--")
      const dashDashIdx = args.indexOf("--");
      if (dashDashIdx >= 0) {
        expect(args[dashDashIdx + 1]).toBe('$(rm -rf /)');
      }
    }
  });
});
