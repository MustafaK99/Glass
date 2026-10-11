// Plays a demo script against the real app, for recording the video and the
// screenshots. Each step does what a person would: press a key, type, click, or
// wait for something to appear. Off unless Glass was started with GLASS_DEMO.

import { demoMark, demoScript, demoWaitGo } from "./bridge";

type Step =
  | { do: "wait"; ms: number }
  | { do: "mark"; name: string }
  | { do: "go" }
  | { do: "key"; key: string; meta?: boolean; shift?: boolean; alt?: boolean; ctrl?: boolean; on?: "focus" | "body" }
  | { do: "type"; text: string; cps?: number }
  | { do: "click"; selector: string; text?: string; last?: boolean }
  | { do: "focus"; selector: string }
  | { do: "waitFor"; selector: string; text?: string; gone?: boolean; timeout?: number }
  // Answer approval cards with A or R, each one marked in and out for the edit,
  // until `until` appears (or after one, with once).
  | { do: "answer"; key: "a" | "r"; until?: string; once?: boolean; hold?: number; timeout?: number };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function find(selector: string, text?: string, last = false): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(selector)].filter((element) => !text || (element.textContent ?? "").includes(text));
  return (last ? all[all.length - 1] : all[0]) ?? null;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  // React tracks the value itself; set it the way the browser would, then say so.
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.setSelectionRange(value.length, value.length);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function run(step: Step) {
  switch (step.do) {
    case "wait":
      return sleep(step.ms);
    case "mark":
      return demoMark(step.name);
    case "go":
      return demoWaitGo();
    case "key": {
      if (step.on === "body") (document.activeElement as HTMLElement | null)?.blur();
      const target = (step.on === "body" ? document.body : document.activeElement) ?? document.body;
      const init = { key: step.key, metaKey: step.meta, shiftKey: step.shift, altKey: step.alt, ctrlKey: step.ctrl, bubbles: true, cancelable: true };
      target.dispatchEvent(new KeyboardEvent("keydown", init));
      target.dispatchEvent(new KeyboardEvent("keyup", init));
      return;
    }
    case "type": {
      const element = document.activeElement;
      if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)) throw new Error("nothing to type into");
      for (const char of step.text) {
        setValue(element, element.value + char);
        await sleep(1000 / (step.cps ?? 22));
      }
      return;
    }
    case "click":
    case "focus": {
      const element = find(step.selector, "text" in step ? step.text : undefined, "last" in step ? step.last : false);
      if (!element) throw new Error(`no ${step.selector}`);
      if (step.do === "click") element.click();
      else element.focus();
      return;
    }
    case "answer": {
      const until = Date.now() + (step.timeout ?? 300_000);
      const hold = step.hold ?? 1400;
      while (Date.now() < until) {
        if (step.until && find(step.until)) return;
        const card = find("section.approval");
        if (card) {
          await demoMark("in");
          await sleep(hold);
          await run({ do: "key", key: step.key, on: "body" });
          await sleep(900);
          await demoMark("out");
          while (card.isConnected) await sleep(100);
          if (step.once) return;
          continue;
        }
        await sleep(100);
      }
      throw new Error("timed out answering approvals");
    }
    case "waitFor": {
      const until = Date.now() + (step.timeout ?? 180_000);
      while (Date.now() < until) {
        const found = find(step.selector, step.text);
        if (step.gone ? !found : found) return;
        await sleep(100);
      }
      throw new Error(`timed out waiting for ${step.selector}${step.text ? ` "${step.text}"` : ""}`);
    }
  }
}

/** Run the demo script, if there is one. Every step is marked, so the recording can be cut. */
export async function playDemo() {
  const text = await demoScript().catch(() => null);
  if (!text) return;
  const steps = JSON.parse(text) as Step[];
  for (const [index, step] of steps.entries()) {
    try {
      await run(step);
    } catch (reason) {
      await demoMark(`failed at step ${index}: ${String(reason)}`);
      return;
    }
  }
  await demoMark("end");
}
