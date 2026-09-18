import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import * as envUtils from "@oh-my-pi/pi-utils/env";
import { imageGenTool } from "@oh-my-pi/pi-coding-agent/tools/image-gen";

const savedEnv = { WT_SESSION: Bun.env.WT_SESSION, WSL_DISTRO_NAME: Bun.env.WSL_DISTRO_NAME };

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
	applyHyperlinkSetting("auto");
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
});

const imagePath = "/tmp/generated image#1.webp";
const result = {
	content: [{ type: "text" as const, text: `Generated 1 image(s):\n  ${imagePath}` }],
	details: {
		provider: "openai-codex" as const,
		model: "test-model",
		imageCount: 1,
		imagePaths: [imagePath],
		images: [],
		responseText: "Image ready.",
	},
};

function renderResult(): string {
	return imageGenTool.renderResult!(result, { expanded: true, isPartial: false }, theme, { subject: "test" })
		.render(200)
		.join("\n");
}

describe("generated image hyperlinks", () => {
	it.skipIf(process.platform === "win32")("links WSL image paths without changing stored output", () => {
		applyHyperlinkSetting("always");
		vi.spyOn(envUtils, "isWsl").mockReturnValue(true);
		Bun.env.WT_SESSION = "image-link-test";
		Bun.env.WSL_DISTRO_NAME = "Ubuntu Dev";

		const rendered = renderResult();
		expect(rendered).toContain("file://wsl.localhost/Ubuntu%20Dev/tmp/generated%20image%231.webp");
		expect(Bun.stripANSI(rendered)).toContain(imagePath);
		expect(result.content[0].text).not.toContain("\x1b");
	});
});
