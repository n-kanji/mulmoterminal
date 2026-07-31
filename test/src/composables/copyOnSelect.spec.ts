import { describe, it, expect } from "vitest";
import { getCopyOnSelect, setCopyOnSelect } from "../../../src/composables/copyOnSelect";

// The browser half of the flag. It matters that this reads the RAW config value: the server
// may not send the field at all (a config.json predating the feature), and the terminal
// manager must then still copy on select rather than silently doing nothing.
describe("copyOnSelect (client)", () => {
  it("is enabled before any config lands", () => {
    expect(getCopyOnSelect()).toBe(true);
  });

  it("stays enabled for a config that omits the field", () => {
    setCopyOnSelect(undefined);
    expect(getCopyOnSelect()).toBe(true);
  });

  it("turns off only on an explicit false, and back on again", () => {
    setCopyOnSelect(false);
    expect(getCopyOnSelect()).toBe(false);
    setCopyOnSelect(true);
    expect(getCopyOnSelect()).toBe(true);
  });
});
