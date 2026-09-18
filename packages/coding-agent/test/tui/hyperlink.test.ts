import { afterEach, describe, expect, it, vi } from "bun:test";
import * as piUtils from "@oh-my-pi/pi-utils";
import { fileUriForTerminal } from "@oh-my-pi/pi-tui/render/hyperlink";

const savedEnv = { WT_SESSION: Bun.env.WT_SESSION, WSL_DISTRO_NAME: Bun.env.WSL_DISTRO_NAME };

afterEach(() => {
	vi.restoreAllMocks();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
});

describe.skipIf(process.platform === "win32")("WSL file hyperlink targets", () => {
	it("routes local files through the active WSL distribution", () => {
		vi.spyOn(piUtils, "isWsl").mockReturnValue(true);
		piUtils.$env.WT_SESSION = "test-windows-terminal";
		piUtils.$env.WSL_DISTRO_NAME = "Ubuntu Dev";

		expect(fileUriForTerminal("/home/user/a#b?c% dé.ts", { line: 12, col: 3 }, "base")).toBe(
			"file://wsl.localhost/Ubuntu%20Dev/home/user/a%23b%3Fc%25%20d%C3%A9.ts",
		);
	});

	it("keeps local file URIs without a Windows Terminal host", () => {
		vi.spyOn(piUtils, "isWsl").mockReturnValue(true);
		delete piUtils.$env.WT_SESSION;
		piUtils.$env.WSL_DISTRO_NAME = "Ubuntu";

		expect(fileUriForTerminal("/home/user/my file.ts", undefined, "base")).toBe("file:///home/user/my%20file.ts");
	});
});
