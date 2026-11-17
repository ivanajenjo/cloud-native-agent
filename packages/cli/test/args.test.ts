import { describe, expect, it } from "vitest";
import { parseCliArgs, USAGE, UsageError } from "../src/args.js";

const DEFAULT_URL = "http://127.0.0.1:8080";

/** Parses with a clean environment and a terminal, unless told otherwise. */
function parse(argv: string[], env: Record<string, string | undefined> = {}, isTty = true) {
  return parseCliArgs(argv, env, isTty);
}

function commandOf(argv: string[], env: Record<string, string | undefined> = {}) {
  return parse(argv, env).command;
}

function usageMessage(argv: string[], env: Record<string, string | undefined> = {}): string {
  try {
    parse(argv, env);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as Error).message;
  }
  throw new Error(`expected a UsageError for ${JSON.stringify(argv)}`);
}

describe("parseCliArgs: help and version", () => {
  it("shows the help without arguments", () => {
    expect(commandOf([])).toEqual({ name: "help" });
  });

  it.each([["help"], ["--help"], ["-h"]])("maps %s to help", (word) => {
    expect(commandOf([word])).toEqual({ name: "help" });
  });

  it.each([["version"], ["--version"]])("maps %s to version", (word) => {
    expect(commandOf([word])).toEqual({ name: "version" });
  });

  it("rejects positionals after help", () => {
    expect(usageMessage(["help", "status"])).toContain("help");
  });
});

describe("parseCliArgs: run", () => {
  it("parses repo and prompt without options", () => {
    expect(commandOf(["run", "owner/repo", "arregla los tests"])).toEqual({
      name: "run",
      repo: "owner/repo",
      prompt: "arregla los tests",
      plan: false,
      autoPush: false,
      detach: false,
    });
  });

  it("parses every run option", () => {
    const command = commandOf([
      "run",
      "owner/repo",
      "haz algo",
      "--plan",
      "--base",
      "develop",
      "--model",
      "anthropic/claude",
      "--thinking",
      "high",
      "--auto-push",
      "--detach",
    ]);

    expect(command).toEqual({
      name: "run",
      repo: "owner/repo",
      prompt: "haz algo",
      plan: true,
      baseBranch: "develop",
      model: "anthropic/claude",
      thinking: "high",
      autoPush: true,
      detach: true,
    });
  });

  it("keeps the prompt as given, without trimming it", () => {
    expect(commandOf(["run", "owner/repo", "  con espacios  "])).toMatchObject({
      prompt: "  con espacios  ",
    });
  });

  it("accepts the repo name characters the server allows", () => {
    expect(commandOf(["run", "My-Org9/repo.name_1", "x"])).toMatchObject({
      repo: "My-Org9/repo.name_1",
    });
  });

  it("requires exactly two positionals", () => {
    expect(usageMessage(["run", "owner/repo"])).toContain("cna run");
    expect(usageMessage(["run"])).toContain("cna run");
    expect(usageMessage(["run", "owner/repo", "uno", "dos"])).toContain("cna run");
  });

  it.each([["foo"], ["a/b/c"], ["owner-/x/y"], ["owner/"], ["/repo"], ["owner/re po"]])(
    "rejects the invalid repo %s",
    (repo) => {
      expect(usageMessage(["run", repo, "prompt"])).toContain("<owner/repo>");
    },
  );

  it.each([[""], ["   "], ["\n\t"]])("rejects a blank prompt %j", (prompt) => {
    expect(usageMessage(["run", "owner/repo", prompt])).toContain("prompt");
  });

  it("rejects an invalid --thinking level", () => {
    expect(usageMessage(["run", "owner/repo", "x", "--thinking", "ultra"])).toContain("--thinking");
  });

  it("rejects an empty --base", () => {
    expect(usageMessage(["run", "owner/repo", "x", "--base", " "])).toContain("--base");
  });

  it("rejects options of other commands", () => {
    expect(usageMessage(["run", "owner/repo", "x", "--force"])).toContain("--force");
  });
});

describe("parseCliArgs: other commands", () => {
  it("maps chat and its alias attach to chat", () => {
    expect(commandOf(["chat"])).toEqual({ name: "chat" });
    expect(commandOf(["attach"])).toEqual({ name: "chat" });
  });

  it.each([["status"], ["todos"], ["abort"]])("parses %s", (word) => {
    expect(commandOf([word])).toEqual({ name: word });
  });

  it("parses diff without options", () => {
    expect(commandOf(["diff"])).toEqual({ name: "diff", checkpoint: undefined, stat: false });
  });

  it("parses diff with --checkpoint and --stat", () => {
    expect(commandOf(["diff", "--checkpoint", "3", "--stat"])).toEqual({
      name: "diff",
      checkpoint: 3,
      stat: true,
    });
  });

  it("accepts checkpoint 0", () => {
    expect(commandOf(["diff", "--checkpoint", "0"])).toMatchObject({ checkpoint: 0 });
  });

  it.each([["01"], ["-1"], ["x"], [""], ["1.5"]])("rejects --checkpoint %j", (value) => {
    expect(usageMessage(["diff", "--checkpoint", value])).toContain("--checkpoint");
  });

  it("parses close without and with --force", () => {
    expect(commandOf(["close"])).toEqual({ name: "close", force: false });
    expect(commandOf(["close", "--force"])).toEqual({ name: "close", force: true });
  });

  it("rejects options that the command does not take", () => {
    expect(usageMessage(["status", "--force"])).toContain("--force");
    expect(usageMessage(["chat", "--stat"])).toContain("--stat");
    expect(usageMessage(["close", "--stat"])).toContain("--stat");
    expect(usageMessage(["todos", "--plan"])).toContain("--plan");
  });

  it("rejects positionals on commands that take none", () => {
    expect(usageMessage(["status", "extra"])).toContain("status");
  });
});

describe("parseCliArgs: global options", () => {
  it.each([
    [["--url", "http://a:1", "status"], "status"],
    [["status", "--url", "http://a:1"], "status"],
    [["status", "--url=http://a:1"], "status"],
    [["run", "--url", "http://a:1", "owner/repo", "x"], "run"],
    [["run", "owner/repo", "x", "--url", "http://a:1"], "run"],
    [["diff", "--url", "http://a:1", "--stat"], "diff"],
  ])("accepts --url in any position: %j", (argv, name) => {
    const { command, options } = parse(argv);
    expect(options.url).toBe("http://a:1");
    expect(command.name).toBe(name);
  });

  it("uses the default URL when nothing is set", () => {
    expect(parse(["status"]).options.url).toBe(DEFAULT_URL);
  });

  it("uses CNA_URL when --url is absent", () => {
    expect(parse(["status"], { CNA_URL: "https://cna.example.invalid" }).options.url).toBe(
      "https://cna.example.invalid",
    );
  });

  it("prefers --url over CNA_URL", () => {
    const { options } = parse(["status", "--url", "http://flag:1"], { CNA_URL: "http://env:1" });
    expect(options.url).toBe("http://flag:1");
  });

  it("ignores an empty CNA_URL", () => {
    expect(parse(["status"], { CNA_URL: "" }).options.url).toBe(DEFAULT_URL);
  });

  it("removes the trailing slashes of the URL", () => {
    expect(parse(["status", "--url", "http://a:1/"]).options.url).toBe("http://a:1");
    expect(parse(["status"], { CNA_URL: "https://a.example.invalid//" }).options.url).toBe(
      "https://a.example.invalid",
    );
  });

  it("rejects URLs that are not http or https", () => {
    expect(usageMessage(["status", "--url", "ftp://x"])).toContain("http");
    expect(usageMessage(["status", "--url", "no-es-url"])).toContain("URL");
    expect(usageMessage(["status"], { CNA_URL: "no-es-url" })).toContain("URL");
  });

  it("does not echo an invalid URL", () => {
    const secret = "http://user:s3cr3t@[";
    expect(usageMessage(["status", "--url", secret])).not.toContain("s3cr3t");
  });

  it("enables color on a terminal", () => {
    expect(parse(["status"], {}, true).options.color).toBe(true);
  });

  it("disables color when not on a terminal", () => {
    expect(parse(["status"], {}, false).options.color).toBe(false);
  });

  it("disables color with --no-color in any position", () => {
    expect(parse(["--no-color", "status"]).options.color).toBe(false);
    expect(parse(["status", "--no-color"]).options.color).toBe(false);
  });

  it("disables color with a non-empty NO_COLOR", () => {
    expect(parse(["status"], { NO_COLOR: "1" }).options.color).toBe(false);
  });

  it("keeps color with an empty NO_COLOR", () => {
    expect(parse(["status"], { NO_COLOR: "" }).options.color).toBe(true);
  });
});

describe("parseCliArgs: errors", () => {
  it("rejects unknown options", () => {
    expect(usageMessage(["status", "--what"])).toContain("--what");
  });

  it("rejects unknown commands", () => {
    expect(usageMessage(["deploy"])).toContain("deploy");
  });

  it("rejects --token and points to CNA_TOKEN without echoing the value", () => {
    const message = usageMessage(["run", "owner/repo", "x", "--token", "abc"]);
    expect(message).toContain("CNA_TOKEN");
    expect(message).not.toContain("abc");
  });

  it("rejects --token=value without echoing the value", () => {
    const message = usageMessage(["status", "--token=abc"]);
    expect(message).toContain("CNA_TOKEN");
    expect(message).not.toContain("abc");
  });

  it("rejects options that are missing their value", () => {
    expect(usageMessage(["status", "--url"])).toContain("--url");
  });
});

describe("parseCliArgs: run --pr", () => {
  it("takes the PR number and keeps the prompt optional with one positional", () => {
    expect(commandOf(["run", "owner/repo", "--pr", "12"])).toEqual({
      name: "run",
      repo: "owner/repo",
      pr: 12,
      plan: false,
      autoPush: false,
      detach: false,
    });
  });

  it("accepts a prompt together with --pr", () => {
    expect(commandOf(["run", "owner/repo", "revisa el PR", "--pr", "12"])).toMatchObject({
      name: "run",
      prompt: "revisa el PR",
      pr: 12,
    });
  });

  it.each([["1"], ["12"], ["1000000000"]])("accepts the PR number %s", (value) => {
    expect(commandOf(["run", "owner/repo", "--pr", value])).toMatchObject({
      pr: Number(value),
    });
  });

  it.each([["0"], ["1.5"], ["x"], ["1000000001"], ["+3"], [""]])(
    "rejects the invalid PR number %j",
    (value) => {
      expect(usageMessage(["run", "owner/repo", "--pr", value])).toBe(
        "--pr debe ser un número de PR",
      );
    },
  );

  it("rejects a negative PR number", () => {
    expect(usageMessage(["run", "owner/repo", "--pr=-1"])).toBe("--pr debe ser un número de PR");
  });

  it("requires the prompt without --pr", () => {
    expect(usageMessage(["run", "owner/repo"])).toContain("cna run");
  });

  it("rejects --base together with --pr", () => {
    expect(usageMessage(["run", "owner/repo", "--pr", "12", "--base", "dev"])).toBe(
      "con --pr la rama base es la del PR",
    );
  });

  it("rejects too many positionals with --pr", () => {
    expect(usageMessage(["run", "owner/repo", "uno", "dos", "--pr", "12"])).toContain("cna run");
  });

  it("rejects a blank prompt with --pr", () => {
    expect(usageMessage(["run", "owner/repo", "  ", "--pr", "12"])).toContain("prompt");
  });

  it("rejects --pr for other commands", () => {
    expect(usageMessage(["status", "--pr", "12"])).toContain("--pr");
  });
});

describe("parseCliArgs: stats, history and resume", () => {
  it("parses stats and history", () => {
    expect(commandOf(["stats"])).toEqual({ name: "stats" });
    expect(commandOf(["history"])).toEqual({ name: "history" });
  });

  it("rejects positionals on stats and history", () => {
    expect(usageMessage(["stats", "extra"])).toContain("stats");
    expect(usageMessage(["history", "extra"])).toContain("history");
  });

  it("parses resume with only the id", () => {
    expect(commandOf(["resume", "3f2a9c1b"])).toEqual({
      name: "resume",
      id: "3f2a9c1b",
      prompt: undefined,
      detach: false,
    });
  });

  it("parses resume with a prompt", () => {
    expect(commandOf(["resume", "3f2a9c1b", "sigue por el test"])).toMatchObject({
      name: "resume",
      id: "3f2a9c1b",
      prompt: "sigue por el test",
      detach: false,
    });
  });

  it("parses resume with --detach", () => {
    expect(commandOf(["resume", "3f2a9c1b", "--detach"])).toMatchObject({
      name: "resume",
      detach: true,
    });
  });

  it("accepts a full UUID as id", () => {
    const id = "3f2a9c1b-0d4e-4f5a-8b6c-7d8e9f0a1b2c";
    expect(commandOf(["resume", id])).toMatchObject({ id });
  });

  it.each([["ab_cd"], ["../x"], ["a b"], ["é"], ["a".repeat(129)]])(
    "rejects the invalid session id %j",
    (id) => {
      expect(usageMessage(["resume", id])).toContain("id de la sesión");
    },
  );

  it("accepts an id of 128 characters", () => {
    expect(commandOf(["resume", "a".repeat(128)])).toMatchObject({ id: "a".repeat(128) });
  });

  it("requires the id", () => {
    expect(usageMessage(["resume"])).toContain("cna resume");
  });

  it("rejects more than one prompt", () => {
    expect(usageMessage(["resume", "3f2a9c1b", "uno", "dos"])).toContain("cna resume");
  });

  it("rejects a blank prompt", () => {
    expect(usageMessage(["resume", "3f2a9c1b", "   "])).toContain("prompt");
  });

  it("rejects options that resume does not take", () => {
    expect(usageMessage(["resume", "3f2a9c1b", "--stat"])).toContain("--stat");
    expect(usageMessage(["stats", "--detach"])).toContain("--detach");
  });
});

describe("USAGE", () => {
  it.each([
    ["run"],
    ["chat"],
    ["attach"],
    ["status"],
    ["stats"],
    ["history"],
    ["resume"],
    ["--pr"],
    ["diff"],
    ["todos"],
    ["abort"],
    ["close"],
    ["help"],
    ["version"],
    ["--plan"],
    ["--base"],
    ["--model"],
    ["--thinking"],
    ["--auto-push"],
    ["--detach"],
    ["--checkpoint"],
    ["--stat"],
    ["--force"],
    ["--url"],
    ["--replica"],
    ["--no-color"],
    ["CNA_URL"],
    ["CNA_REPLICA"],
    ["CNA_TOKEN"],
  ])("mentions %s", (text) => {
    expect(USAGE).toContain(text);
  });

  it("lists the replicas command", () => {
    expect(USAGE).toContain("cna replicas");
  });
});

describe("parseCliArgs: replicas", () => {
  it("maps replicas to its own command without arguments", () => {
    expect(commandOf(["replicas"])).toEqual({ name: "replicas" });
  });

  it("rejects positionals after replicas", () => {
    expect(usageMessage(["replicas", "extra"])).toContain("replicas");
  });

  it("accepts --replica with any command", () => {
    expect(parse(["status", "--replica", "agent-2"]).options.replica).toBe("agent-2");
    expect(commandOf(["status", "--replica", "agent-2"])).toEqual({ name: "status" });
  });
});

describe("parseCliArgs: --replica and CNA_REPLICA", () => {
  it("takes the replica from --replica", () => {
    expect(parse(["status", "--replica", "agent-2"]).options.replica).toBe("agent-2");
  });

  it("takes the replica from CNA_REPLICA without the flag", () => {
    expect(parse(["status"], { CNA_REPLICA: "agent-3" }).options.replica).toBe("agent-3");
  });

  it("prefers --replica over CNA_REPLICA", () => {
    const options = parse(["status", "--replica", "agent-2"], { CNA_REPLICA: "agent-3" }).options;
    expect(options.replica).toBe("agent-2");
  });

  it("treats an empty CNA_REPLICA as unset", () => {
    expect(parse(["status"], { CNA_REPLICA: "" }).options.replica).toBeUndefined();
  });

  it("has no replica by default", () => {
    expect(parse(["status"]).options.replica).toBeUndefined();
  });

  it.each([["Agent-2"], ["../x"], [""]])(
    "rejects the invalid name %j without echoing it",
    (name) => {
      const message = usageMessage(["status", "--replica", name]);
      expect(message).toBe("el nombre de la réplica no es válido (p. ej. agent-2)");
      if (name !== "") expect(message).not.toContain(name);
    },
  );

  it("rejects an invalid CNA_REPLICA without echoing it", () => {
    const message = usageMessage(["status"], { CNA_REPLICA: "Agent-9" });
    expect(message).toBe("el nombre de la réplica no es válido (p. ej. agent-2)");
    expect(message).not.toContain("Agent-9");
  });

  it("requires a value for --replica", () => {
    expect(usageMessage(["status", "--replica"])).toContain("--replica");
  });
});
