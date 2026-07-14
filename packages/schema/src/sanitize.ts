import type { Binding, UINode } from "./index";

/**
 * Shared sanitizer for free-form element trees. Runs on BOTH sides:
 *  - server, mode "strict": violations are returned verbatim so the LLM
 *    retry loop can self-correct before anything is stored.
 *  - client, mode "strip": offending attrs/styles are dropped and
 *    disallowed elements are replaced with a plain <div>, as defense in
 *    depth on every render (stored trees are replayed from the DB).
 *
 * The tag/attr allowlists below are also inlined into the Tier-1 system
 * prompt so the LLM only ever sees the vocabulary it may use.
 */

export const SAFE_TAGS = new Set([
  // structural / text
  "div", "span", "section", "article", "header", "footer", "main", "aside", "nav",
  "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
  "blockquote", "pre", "code", "hr", "br",
  "strong", "em", "b", "i", "u", "s", "small", "sup", "sub", "mark", "abbr", "kbd",
  "figure", "figcaption", "details", "summary", "label", "a",
  "progress", "meter", "time",
  // media
  "img", "video", "audio", "source", "track", "canvas",
  // svg subset (no foreignObject / use / script-bearing nodes)
  "svg", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon",
  "g", "text", "tspan", "defs", "linearGradient", "radialGradient", "stop",
  "clipPath", "mask", "pattern", "symbol", "title", "desc",
]);

/** Attributes allowed on any tag. */
const GLOBAL_ATTRS = new Set([
  "id", "title", "role", "lang", "dir", "tabindex",
  "width", "height", "alt", "type",
  "datetime", "value", "max", "min", "open", "draggable",
]);

/** Extra attributes allowed per tag. */
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel", "download"]),
  img: new Set(["src", "srcset", "sizes", "loading", "decoding"]),
  video: new Set([
    "src", "poster", "controls", "autoplay", "loop", "muted", "playsinline",
    "preload", "volume", "crossorigin",
  ]),
  audio: new Set(["src", "controls", "autoplay", "loop", "muted", "preload", "volume", "crossorigin"]),
  source: new Set(["src", "srcset", "media", "sizes"]),
  track: new Set(["src", "kind", "srclang", "label", "default"]),
  time: new Set(["datetime"]),
  progress: new Set(["value", "max"]),
  meter: new Set(["value", "min", "max", "low", "high", "optimum"]),
  canvas: new Set([]),
  label: new Set([]),
};

/** SVG presentation/geometry attributes (allowed on the svg subset only). */
const SVG_ATTRS = new Set([
  "viewBox", "xmlns", "preserveAspectRatio",
  "d", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset",
  "stroke-opacity", "opacity",
  "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2",
  "points", "transform", "offset", "stop-color", "stop-opacity",
  "gradientUnits", "gradientTransform", "spreadMethod",
  "text-anchor", "dominant-baseline", "font-size", "font-family", "font-weight",
  "dx", "dy", "pathLength", "clip-path", "clip-rule",
]);

const SVG_TAGS = new Set([
  "svg", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon",
  "g", "text", "tspan", "defs", "linearGradient", "radialGradient", "stop",
  "clipPath", "mask", "pattern", "symbol", "title", "desc",
]);

/** Attributes whose values are URLs and must pass the protocol check. */
const URL_ATTRS = new Set(["src", "href", "poster", "srcset"]);

/** Categorically rejected regardless of tag (defense against event handlers etc.). */
const REJECT_ATTR = /^on/i;
const REJECT_ATTRS = new Set(["style", "class", "classname", "srcdoc", "formaction", "action", "xlink:href"]);

export function sanitizeUrl(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v.startsWith("javascript:") || v.startsWith("vbscript:")) return false;
  if (v.startsWith("data:")) return v.startsWith("data:image/");
  if (v.startsWith("https:") || v.startsWith("http:")) return true;
  // same-origin relative paths (/uploads/…, /api/…) and fragment/relative refs
  if (v.startsWith("//")) return false; // protocol-relative — ambiguous, reject
  return !v.includes(":");
}

const STYLE_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/;

export function sanitizeStyleValue(value: string | number): boolean {
  if (typeof value === "number") return true;
  const v = value.toLowerCase();
  if (v.includes("expression(") || v.includes("-moz-binding") || v.includes("behavior:")) {
    return false;
  }
  // url(...) allowed only with a safe URL inside
  const urlMatch = v.match(/url\(\s*['"]?([^'")]*)/);
  if (urlMatch && !sanitizeUrl(urlMatch[1])) return false;
  return true;
}

export interface SanitizeResult {
  node: UINode;
  violations: string[];
}

/**
 * Walk a UINode tree enforcing the allowlists.
 *  - "strict": nothing is modified; every violation is reported (server-side,
 *    feeds the LLM retry loop).
 *  - "strip": offending attrs/styles are removed and disallowed tags become
 *    <div>; violations are still reported for logging.
 * Component/text nodes pass through untouched (component props are consumed
 * by registry components, never spread onto DOM elements).
 */
export function sanitizeTree(root: UINode, mode: "strict" | "strip"): SanitizeResult {
  const violations: string[] = [];

  /** UINode-shaped prop values (itemTemplate & friends) must be walked too —
   *  they are rendered as node trees and would otherwise bypass sanitation. */
  function isNodeLike(v: unknown): v is UINode {
    return (
      typeof v === "object" &&
      v !== null &&
      !Array.isArray(v) &&
      ["text", "element", "component"].includes((v as { kind?: unknown }).kind as string)
    );
  }

  function walk(node: UINode, path: string): UINode {
    if (node.kind !== "element") {
      if (node.kind === "component") {
        let props = node.props;
        if (props) {
          props = { ...props };
          for (const [key, value] of Object.entries(props)) {
            if (isNodeLike(value)) props[key] = walk(value, `${path}.props.${key}`);
          }
        }
        return {
          ...node,
          props,
          children: node.children?.map((c, i) => walk(c, `${path}.children[${i}]`)),
        };
      }
      return node;
    }

    let tag = node.tag.toLowerCase();
    if (!SAFE_TAGS.has(tag)) {
      violations.push(`${path}: tag <${node.tag}> is not allowed`);
      if (mode === "strip") tag = "div";
    }

    const attrs: Record<string, string | number | boolean | object> = {};
    const isSvg = SVG_TAGS.has(tag);
    for (const [rawName, value] of Object.entries(node.attrs ?? {})) {
      const name = rawName.toLowerCase();
      if (REJECT_ATTR.test(name) || REJECT_ATTRS.has(name)) {
        violations.push(`${path}: attribute "${rawName}" is not allowed`);
        continue;
      }
      const allowed =
        GLOBAL_ATTRS.has(name) ||
        TAG_ATTRS[tag]?.has(name) ||
        (isSvg && (SVG_ATTRS.has(rawName) || SVG_ATTRS.has(name))) ||
        name.startsWith("aria-") ||
        name.startsWith("data-");
      if (!allowed) {
        violations.push(`${path}: attribute "${rawName}" is not allowed on <${tag}>`);
        continue;
      }
      if (URL_ATTRS.has(name) && typeof value === "string" && !sanitizeUrl(value)) {
        violations.push(`${path}: unsafe URL in "${rawName}"`);
        continue;
      }
      attrs[rawName] = value as string | number | boolean;
    }

    const style: Record<string, string | number | Binding> = {};
    for (const [prop, value] of Object.entries(node.style ?? {})) {
      if (!STYLE_NAME.test(prop)) {
        violations.push(`${path}: style property "${prop}" must be camelCase`);
        continue;
      }
      if (typeof value === "object" && value !== null) {
        // A $if binding — scan both literal branches like plain values.
        const branches = [
          (value as { then?: unknown }).then,
          (value as { else?: unknown }).else,
        ];
        const unsafe = branches.some(
          (b) => (typeof b === "string" || typeof b === "number") && !sanitizeStyleValue(b),
        );
        if (unsafe) {
          violations.push(`${path}: unsafe style value in "$if" branches of "${prop}"`);
          continue;
        }
        style[prop] = value as Binding;
        continue;
      }
      if (!sanitizeStyleValue(value)) {
        violations.push(`${path}: unsafe style value for "${prop}"`);
        continue;
      }
      style[prop] = value;
    }

    const children = (node.children ?? []).map((c, i) =>
      walk(c, `${path}.children[${i}]`),
    );

    return {
      ...node,
      tag,
      attrs: Object.keys(attrs).length ? (attrs as never) : undefined,
      style: Object.keys(style).length ? style : undefined,
      children: children.length ? children : undefined,
    };
  }

  const node = walk(root, "root");
  return { node: mode === "strip" ? node : root, violations };
}
