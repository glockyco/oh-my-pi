import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { getMarkdownLinkUrls, TERMINAL } from "@oh-my-pi/pi-tui";
import { $env, isWsl } from "@oh-my-pi/pi-utils";
import { fileUriForTerminal } from "@oh-my-pi/pi-tui/render/hyperlink";
import {
	extractUriScheme,
	InternalUrlRouter,
	LocalProtocolHandler,
	memoryRootsFromRegistry,
	parseInternalUrl,
	type ResolveContext,
	resolveLocalUrlToPath,
	resolveMemoryUrlToPath,
} from "./index";
import { expandPath, probeLiteralPathExists } from "../tools/path-utils";

const FILE_POSITION_RE = /:(?:[1-9]\d*:[1-9]\d*|[1-9]\d*(?:-[1-9]\d*)?)$/;
const FILE_LINE_FRAGMENT_RE = /^#L[1-9]\d*(?:C[1-9]\d*)?(?:-L?[1-9]\d*(?:C[1-9]\d*)?)?$/;
const FILE_POSITION_QUERY_KEYS = ["line", "col", "column"] as const;
const POSITIVE_INTEGER_RE = /^[1-9]\d*$/;

function withoutFilePositions(suffix: string): string {
	if (!suffix) return suffix;
	const hashIndex = suffix.indexOf("#");
	let query = hashIndex < 0 ? suffix : suffix.slice(0, hashIndex);
	let hash = hashIndex < 0 ? "" : suffix.slice(hashIndex);
	if (FILE_LINE_FRAGMENT_RE.test(hash)) hash = "";
	if (query.startsWith("?")) {
		const params = new URLSearchParams(query);
		for (const key of FILE_POSITION_QUERY_KEYS) {
			const values = params.getAll(key);
			if (values.length > 0 && values.every(value => POSITIVE_INTEGER_RE.test(value))) params.delete(key);
		}
		query = params.size > 0 ? `?${params}` : "";
	}
	return query + hash;
}

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

async function resolveFileLink(href: string, cwd: string): Promise<{ sourcePath: string; suffix: string }> {
	const isFileUrl = extractUriScheme(href) === "file";
	const suffixIndex = href.search(/[?#]/);
	const rawPath = suffixIndex < 0 ? href : href.slice(0, suffixIndex);
	const originalSuffix = suffixIndex < 0 ? "" : href.slice(suffixIndex);
	const suffix = withoutFilePositions(originalSuffix);
	const decoded = isFileUrl ? localPathFromFileUri(rawPath) : decodeURIComponent(rawPath);
	let sourcePath = path.resolve(cwd, expandPath(decoded));
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
			if (!href || /[\x00-\x1f\x7f]/.test(href) || /^(?:#|\?|\/\/)/.test(href)) continue;
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
				targets.set(href, fileUriForTerminal(sourcePath, undefined, TERMINAL.id) + suffix);
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
