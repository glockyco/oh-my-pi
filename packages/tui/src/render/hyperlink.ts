/**
 * OSC 8 terminal hyperlink support for paths and URLs.
 *
 * Wraps display text in `ESC ] 8 ; id=HASH ; URI ESC \ TEXT ESC ] 8 ; ; ESC \`
 * sequences when the active terminal supports hyperlinks and the user setting
 * permits it. Falls back to plain text when disabled.
 */
import * as url from "node:url";
import { $env, isWsl } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { isSettingsInitialized, settings } from "../config/settings";
import {
	extractUriScheme,
	InternalUrlRouter,
	LocalProtocolHandler,
	memoryRootsFromRegistry,
	parseInternalUrl,
	type ResolveContext,
	resolveLocalUrlToPath,
	resolveMemoryUrlToPath,
} from "../internal-urls";
import { span } from "../native/describe";
import { expandPath, probeLiteralPathExists } from "../tools/path-utils";
import { setTerminalHyperlinks, TERMINAL, type TerminalId } from "../terminal-capabilities";

const OSC = "\x1b]";
const ST = "\x1b\\";
const BEL = "\x07";

/**
 * The terminal's detected OSC 8 capability, captured once at import before any
 * policy application mutates {@link TERMINAL}.hyperlinks. `auto` resolves against
 * this immutable value so a prior `always`/`off` selection can never poison
 * detection when the user switches back to `auto`.
 */
const DETECTED_TERMINAL_HYPERLINKS = TERMINAL.hyperlinks;
type HyperlinkMode = "off" | "auto" | "always";
let hyperlinkMode: HyperlinkMode = "auto";

/** Stable 8-char hex ID derived from a URI — hints terminals to coalesce identical adjacent links. */
function buildLinkId(uri: string): string {
	let h = 0;
	for (let i = 0; i < uri.length; i++) {
		// FNV-1a-inspired mix — good enough for a UI hint, no deps
		h = (Math.imul(31, h) + uri.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Build the OSC 8 target for a file path on `terminalId`.
 *
 * A `file:` URI handed to an editor has to be a plain path. `Paths.get(URI)`
 * rejects one carrying a query or a fragment outright. The VS Code family
 * instead accepts its documented `vscode://file/<path>:<line>:<col>` form.
 */
export function fileUriForTerminal(
	filePath: string,
	opts: { line?: number; col?: number } | undefined,
	terminalId: TerminalId,
): string {
	if (terminalId !== "vscode") {
		const uri = url.pathToFileURL(filePath);
		if (isWsl() && $env.WT_SESSION && $env.WSL_DISTRO_NAME) {
			uri.hostname = "wsl.localhost";
			uri.pathname = `/${encodeURIComponent($env.WSL_DISTRO_NAME)}${uri.pathname}`;
		}
		return uri.href;
	}
	const asPath = filePath.replace(/\\/gu, "/");
	const encodedPath = asPath
		.split("/")
		.map((segment, index) => (index === 0 && /^[a-z]:$/iu.test(segment) ? segment : encodeURIComponent(segment)))
		.join("/");
	const position =
		opts?.line === undefined ? "" : opts.col === undefined ? `:${opts.line}` : `:${opts.line}:${opts.col}`;
	return `vscode://file${encodedPath.startsWith("/") ? "" : "/"}${encodedPath}${position}`;
}

/** Build the OSC 8 target for `filePath` on this terminal. */
function buildFileUri(filePath: string, opts?: { line?: number; col?: number }): string {
	return fileUriForTerminal(filePath, opts, TERMINAL.id);
}

/**
 * Returns true when OSC 8 hyperlinks should be emitted.
 *
 * Respects `tui.hyperlinks` setting:
 * - `"off"`: never
 * - `"auto"`: when `process.stdout.isTTY`, `NO_COLOR` is unset, and the detected terminal reports hyperlink support
 * - `"always"`: unconditionally (useful for viewers that support OSC 8 without advertising it)
 * Uses the last policy pushed by the host, defaulting to `"auto"`.
 */
export function isHyperlinkEnabled(): boolean {
	return resolveHyperlinkMode(hyperlinkMode);
}

function resolveHyperlinkMode(mode: HyperlinkMode): boolean {
	if (mode === "off") return false;
	if (mode === "always") return true;
	// auto: respect the detected capability (immutable snapshot, not the mutable
	// runtime flag that applyHyperlinkSetting overwrites) and NO_COLOR.
	if (Bun.env.NO_COLOR) return false;
	if (!process.stdout.isTTY) return false;
	return DETECTED_TERMINAL_HYPERLINKS;
}

/**
 * Push the resolved `tui.hyperlinks` policy into {@link TERMINAL}.hyperlinks, the
 * effective flag that pi-tui renderers gating on it directly — the Markdown
 * component's `[text](url)`/bare-URL links and the status-line PR link — consult.
 *
 * Detection stays immutable in {@link DETECTED_TERMINAL_HYPERLINKS}, so this only
 * ever writes the effective decision; `auto` transitions restore real detection
 * via {@link isHyperlinkEnabled}. Called at TUI startup and whenever the setting
 * changes at runtime.
 * Accepts the raw (unvalidated) setting value; anything but a known mode falls
 * back to the last policy pushed by the host.
 */
export function applyHyperlinkSetting(mode?: unknown): void {
	if (mode === "off" || mode === "auto" || mode === "always") hyperlinkMode = mode;
	setTerminalHyperlinks(isHyperlinkEnabled());
}

function safeHyperlinkUri(uri: string): string | undefined {
	if (!uri || /[\x00-\x1f\x7f]/.test(uri)) return undefined;
	return uri;
}

function wrapHyperlinkCore(uri: string, displayText: string, terminator: typeof ST | typeof BEL): string {
	// Do not double-wrap if the text already embeds an OSC 8 sequence.
	if (displayText.includes("\x1b]8;")) return displayText;
	const safeUri = safeHyperlinkUri(uri);
	if (!safeUri) return displayText;
	const id = buildLinkId(safeUri);
	return `${OSC}8;id=${id};${safeUri}${terminator}${displayText}${OSC}8;;${terminator}`;
}

function wrapHyperlink(uri: string, displayText: string): string {
	if (!isHyperlinkEnabled()) return displayText;
	return wrapHyperlinkCore(uri, displayText, ST);
}

/**
 * Wrap `displayText` in an OSC 8 hyperlink pointing at `uri`.
 *
 * Returns `displayText` unchanged when hyperlinks are disabled, `uri` contains
 * terminal control bytes, or `displayText` already contains an OSC 8 sequence.
 */
export function uriHyperlink(uri: string, displayText: string): string {
	return wrapHyperlink(uri, displayText);
}

/**
 * Wrap `displayText` in an OSC 8 hyperlink pointing at an HTTP(S) URL.
 * `www.example.com` inputs are linked as `https://www.example.com`.
 */
export function urlHyperlink(url: string, displayText: string): string {
	const normalized = url.match(/^www\./i) ? `https://${url}` : url;
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return displayText;
		return wrapHyperlink(parsed.href, displayText);
	} catch {
		return displayText;
	}
}

/**
 * Wrap `displayText` in an OSC 8 hyperlink pointing at an HTTP(S) URL,
 * bypassing terminal capability auto-detection. Used for auth prompts where
 * an inert "click" label blocks login on terminals whose capabilities are
 * not advertised. Still returns plain text when the host has explicitly opted
 * out by pushing the `"off"` policy.
 */
export function urlHyperlinkAlways(url: string, displayText: string): string {
	if (hyperlinkMode === "off") return displayText;
	const normalized = url.match(/^www\./i) ? `https://${url}` : url;
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return displayText;
		return wrapHyperlinkCore(parsed.href, displayText, BEL);
	} catch {
		return displayText;
	}
}

/**
 * A native link span to an HTTP(S) URL (`www.` inputs become `https://`).
 * Unlike the OSC 8 wrappers this ignores terminal capability detection — a
 * TSP terminal always handles `href` — but honours an explicit `off` policy.
 * Non-HTTP(S) or unparsable URLs yield a plain span.
 */
export function urlLinkSpan(target: string, displayText: string, s = "link"): TspSpan {
	if (hyperlinkMode === "off") return span(displayText, s);
	const normalized = target.match(/^www\./i) ? `https://${target}` : target;
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return span(displayText, s);
		const href = safeHyperlinkUri(parsed.href);
		return href ? span(displayText, s, { href }) : span(displayText, s);
	} catch {
		return span(displayText, s);
	}
}

/**
 * A native link span to a filesystem path as a plain `file://` URI (the
 * terminal opens it through the system; the location stays in the visible
 * text). Honours an explicit `off` policy.
 */
export function fileLinkSpan(filePath: string, displayText: string, s = "path"): TspSpan {
	if (hyperlinkMode === "off") return span(displayText, s);
	const href = safeHyperlinkUri(url.pathToFileURL(filePath).href);
	return href ? span(displayText, s, { href }) : span(displayText, s);
}

/**
 * Wrap `displayText` in an OSC 8 hyperlink pointing at a filesystem path.
 *
 * Returns `displayText` unchanged when hyperlinks are disabled or when
 * the text already contains an OSC 8 sequence (prevents double-wrapping).
 * Relative paths resolve against the current working directory before URI
 * encoding so the OSC 8 target is always a valid `file://` URL.
 * Positions belong in the display text. Generic file handlers have no portable line/column protocol.
 *
 * @param filePath - Filesystem path
 * @param displayText - Text to render as the hyperlink anchor (may contain ANSI codes)
 */
export function fileHyperlink(filePath: string, displayText: string): string {
	return wrapHyperlink(buildFileUri(filePath), displayText);
}

const FILE_POSITION_RE = /:(?:[1-9]\d*:[1-9]\d*|[1-9]\d*(?:-[1-9]\d*)?)$/;
const FILE_LINE_FRAGMENT_RE = /^#L[1-9]\d*(?:C[1-9]\d*)?(?:-L?[1-9]\d*(?:C[1-9]\d*)?)?$/;
const FILE_POSITION_QUERY_KEYS = ["line", "col", "column"] as const;
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;

/** Remove recognized source positions without changing unrelated query or fragment semantics. */
function withoutFilePositions(suffix: string): string {
	if (!suffix) return suffix;
	const hashIndex = suffix.indexOf("#");
	let query = hashIndex < 0 ? suffix : suffix.slice(0, hashIndex);
	let hash = hashIndex < 0 ? "" : suffix.slice(hashIndex);
	if (FILE_LINE_FRAGMENT_RE.test(hash)) hash = "";
	if (query.startsWith("?")) {
		const params = new URLSearchParams(query);
		let changed = false;
		for (const key of FILE_POSITION_QUERY_KEYS) {
			const values = params.getAll(key);
			if (values.length > 0 && values.every(value => POSITIVE_INTEGER_RE.test(value))) {
				params.delete(key);
				changed = true;
			}
		}
		if (changed) query = params.size > 0 ? `?${params}` : "";
	}
	return query + hash;
}

/** Translate only this distribution's WSL share before checking the local filesystem. */
function localPathFromFileUri(href: string): string {
	const parsed = new URL(href);
	if (isWsl() && (parsed.hostname === "wsl.localhost" || parsed.hostname === "wsl$")) {
		const separator = parsed.pathname.indexOf("/", 1);
		const distribution = decodeURIComponent(parsed.pathname.slice(1, separator < 0 ? undefined : separator));
		if (distribution === $env.WSL_DISTRO_NAME) {
			parsed.hostname = "";
			parsed.pathname = separator < 0 ? "/" : parsed.pathname.slice(separator);
		}
	}
	return url.fileURLToPath(parsed);
}

/** A literal filesystem entry wins over a source-location interpretation, including a dangling symlink. */
async function resolveFileLink(href: string, cwd: string): Promise<{ sourcePath: string; suffix: string }> {
	const isFileUrl = extractUriScheme(href) === "file";
	const suffixIndex = href.search(/[?#]/);
	const rawPath = suffixIndex < 0 ? href : href.slice(0, suffixIndex);
	const originalSuffix = suffixIndex < 0 ? "" : href.slice(suffixIndex);
	const suffix = withoutFilePositions(originalSuffix);
	const decoded = isFileUrl ? localPathFromFileUri(rawPath) : decodeURIComponent(rawPath);
	let sourcePath = path.resolve(cwd, expandPath(decoded));

	// An explicit file URI defines its delimiters. A plain POSIX path can contain them literally.
	if (!isFileUrl && suffix !== originalSuffix && (process.platform !== "win32" || !href.includes("?"))) {
		const literal = path.resolve(cwd, expandPath(decodeURIComponent(href)));
		if ((await probeLiteralPathExists(literal, cwd)) !== "missing") return { sourcePath: literal, suffix: "" };
	}

	const position = FILE_POSITION_RE.exec(rawPath);
	if (position && (await probeLiteralPathExists(sourcePath, cwd)) === "missing") {
		const base = rawPath.slice(0, position.index);
		const decodedBase = isFileUrl ? localPathFromFileUri(base) : decodeURIComponent(base);
		sourcePath = path.resolve(cwd, expandPath(decodedBase));
	}
	return { sourcePath, suffix };
}

/**
 * Resolve Markdown hyperlinks to existing local resources or absolute file URLs.
 * Relative paths use the calling session's cwd; missing, virtual, and remote targets stay unchanged.
 */
export async function resolveMarkdownLinkTargets(
	texts: readonly string[],
	context?: ResolveContext,
): Promise<ReadonlyMap<string, string>> {
	const targets = new Map<string, string>();
	const urls = new Set<string>();
	const router = InternalUrlRouter.instance();
	for (const text of texts) {
		for (const href of getMarkdownLinkUrls(text)) {
			if (!safeHyperlinkUri(href) || /^(?:#|\?|\/\/)/.test(href)) continue;
			const scheme = extractUriScheme(href);
			// Rendering must not fetch remote resources or materialize secrets.
			if (
				!scheme ||
				scheme === "file" ||
				(/^(?:agent|artifact|history|local|memory|omp|rule|skill):\/\//i.test(href) && router.canHandle(href))
			) {
				urls.add(href);
			}
		}
	}
	await Promise.all(
		[...urls].map(async href => {
			try {
				let sourcePath: string;
				let suffix: string;
				if (router.canHandle(href)) {
					const resource = await router.resolve(href, { ...context, pathOnly: true, skipDirectoryListing: true });
					if (!resource.sourcePath) return;
					sourcePath = resource.sourcePath;
					suffix = withoutFilePositions(parseInternalUrl(href).hash);
				} else {
					({ sourcePath, suffix } = await resolveFileLink(href, context?.cwd ?? process.cwd()));
				}
				const stat = await fs.stat(sourcePath);
				if (!stat.isFile() && !stat.isDirectory()) return;
				targets.set(href, buildFileUri(sourcePath) + suffix);
			} catch {
				// A model-authored link may be incomplete, stale, or outside the resource root.
			}
		}),
	);
	return targets;
}

/**
 * Synchronously resolve a filesystem-backed internal URL (e.g. `local://foo.md`,
 * `memory://root/notes.md`) to its absolute filesystem path. Returns `undefined`
 * for inputs that aren't fs-backed, aren't resolvable in the current session
 * registry, or fail to parse.
 *
 * Used by renderers to wrap fs-backed internal URLs in OSC 8 hyperlinks even
 * when the resolved path isn't yet available from tool result details (e.g.
 * during the call/streaming phase before a result lands).
 *
 * Async-resolved schemes (`artifact://`, `agent://`, `skill://`, `rule://`,
 * `omp://`) are not handled here — those rely on `details.resolvedPath` set
 * by the read tool's router resolution.
 */
export function tryResolveInternalUrlSync(input: string): string | undefined {
	try {
		if (input.startsWith("local://")) {
			const opts = LocalProtocolHandler.resolveOptions();
			if (!opts) return undefined;
			return resolveLocalUrlToPath(input, opts);
		}
		if (input.startsWith("memory://")) {
			const url = parseInternalUrl(input);
			const roots = memoryRootsFromRegistry();
			for (const root of roots) {
				try {
					return resolveMemoryUrlToPath(url, root);
				} catch {
					// Try the next root; some sessions may not have this namespace mounted.
				}
			}
			return undefined;
		}
	} catch {
		return undefined;
	}
	return undefined;
}
