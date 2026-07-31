// Draws the favicon on a 32×32 canvas and swaps <link rel="icon"> to the result.
// The mark is a terminal prompt — a white "❯" chevron with an accent-colored "_"
// cursor on a dark window — so it reads as a CLI at a glance and is visibly distinct
// from mulmoclaude's mascot/"M" favicon. The accent color is one state signal, so the caller
// maps its state → color; it also passes how many panes are waiting on an answer, stamped on
// as a count, because colour alone says "something is waiting" and never "how many" (R14).
import { watch, type ComputedRef, type Ref } from "vue";

const SIZE = 32;
const RADIUS = 7;
const WINDOW_BG = "#1a1a2e"; // the terminal window (midnight)
const PROMPT_FG = "#e8e8f0"; // the "❯" chevron — constant terminal identity
const BADGE_BG = "#e0453a"; // the count disc — red, a colour the accent never takes
const BADGE_FG = "#ffffff";

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPrompt(ctx: CanvasRenderingContext2D, accent: string): void {
  ctx.strokeStyle = PROMPT_FG;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(10, 9);
  ctx.lineTo(16, 16);
  ctx.lineTo(10, 23);
  ctx.stroke();
  ctx.fillStyle = accent; // the cursor carries the state color
  roundedRect(ctx, 18, 20.5, 8, 3, 1.5);
  ctx.fill();
}

/** The badge text for a count. Two digits is all that fits legibly at 16px, and past ten the
 *  exact number stops changing what the operator does — so anything larger reads "9+". */
export function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return count > 9 ? "9+" : String(Math.floor(count));
}

// A filled disc in the top-right with the count on it. Drawn LAST so it sits over the window
// border, which is what makes it survive the browser's downscale to 16px.
function drawBadge(ctx: CanvasRenderingContext2D, text: string): void {
  ctx.beginPath();
  ctx.arc(22, 10, 10, 0, Math.PI * 2);
  ctx.fillStyle = BADGE_BG;
  ctx.fill();
  ctx.fillStyle = BADGE_FG;
  ctx.font = `bold ${text.length > 1 ? 12 : 15}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 22, 11);
}

function render(accent: string, count: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  roundedRect(ctx, 1, 1, SIZE - 2, SIZE - 2, RADIUS);
  ctx.fillStyle = WINDOW_BG;
  ctx.fill();
  roundedRect(ctx, 2.5, 2.5, SIZE - 5, SIZE - 5, RADIUS - 1.5);
  ctx.strokeStyle = accent; // state-colored ring reinforces the cursor at 16px
  ctx.lineWidth = 2;
  ctx.stroke();
  drawPrompt(ctx, accent);
  const badge = badgeText(count);
  if (badge) drawBadge(ctx, badge);
  return canvas.toDataURL("image/png");
}

function applyFavicon(dataUrl: string): void {
  if (!dataUrl) return;
  const existing = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  const link = existing ?? document.head.appendChild(Object.assign(document.createElement("link"), { rel: "icon" }));
  link.type = "image/png";
  link.href = dataUrl;
}

// Repaint the favicon whenever the accent color OR the waiting count changes. `count` is
// optional so a caller that only tracks colour keeps working unchanged.
export function useDynamicFavicon(color: Ref<string> | ComputedRef<string>, count?: Ref<number> | ComputedRef<number>): void {
  watch([color, () => count?.value ?? 0], ([accent, waiting]) => applyFavicon(render(accent, waiting)), { immediate: true });
}
