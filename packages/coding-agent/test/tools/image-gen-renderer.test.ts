import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Tool } from "@oh-my-pi/pi-coding-agent/tools";
import { imageGenTool } from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import { renderXdevResult } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import * as envUtils from "@oh-my-pi/pi-utils/env";

const savedEnv = { WT_SESSION: Bun.env.WT_SESSION, WSL_DISTRO_NAME: Bun.env.WSL_DISTRO_NAME };

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	settings.clearOverride("tui.hyperlinks");
});
afterAll(() => resetSettingsForTest());

const imagePath = "/tmp/generated image#1.webp";
const summary = `Provider: openai-codex\nModel: test-model\nGenerated 1 image(s):\n  ${imagePath}\n\nImage ready.`;
const result = {
	content: [{ type: "text" as const, text: summary }],
	details: {
		provider: "openai-codex" as const,
		model: "test-model",
		imageCount: 1,
		imagePaths: [imagePath],
		images: [],
		responseText: "Image ready.",
	},
};

function renderDevice(expanded = true): string {
	return renderXdevResult(
		{ tool: "generate_image", inner: result.details, args: { subject: "test" }, mode: "execute" },
		result,
		{ expanded, isPartial: false },
		theme,
		() => imageGenTool as unknown as Tool,
	)!
		.render(200)
		.join("\n");
}

describe("generated image hyperlinks", () => {
	it("keeps response text collapsed until expanded", () => {
		expect(Bun.stripANSI(renderDevice(false))).not.toContain("Image ready.");
		expect(Bun.stripANSI(renderDevice(true))).toContain("Image ready.");
	});

	it.skipIf(process.platform === "win32")(
		"links device results to encoded WSL image paths without changing stored output",
		() => {
			settings.override("tui.hyperlinks", "always");
			vi.spyOn(envUtils, "isWsl").mockReturnValue(true);
			Bun.env.WT_SESSION = "image-link-test";
			Bun.env.WSL_DISTRO_NAME = "Ubuntu Dev";
			const rendered = renderDevice();
			expect(rendered).toContain("file://wsl.localhost/Ubuntu%20Dev/tmp/generated%20image%231.webp");
			expect(Bun.stripANSI(rendered)).toContain(imagePath);
			expect(Bun.stripANSI(rendered)).toContain("Image ready.");
			expect(result.content[0].text).toBe(summary);
			expect(result.content[0].text).not.toContain("\x1b");
		},
	);

	it("keeps image paths plain when hyperlinks are disabled", () => {
		settings.override("tui.hyperlinks", "off");
		const rendered = renderDevice();
		expect(rendered).not.toContain("\x1b]8;");
		expect(Bun.stripANSI(rendered)).toContain(imagePath);
	});
});
