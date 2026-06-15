import { afterEach, describe, expect, it, vi } from "vitest";

import { log } from "../src/logger";

describe("log", () => {
  afterEach(() => {
    delete process.env.PI_AZURE_FOUNDRY_DEBUG;
    vi.restoreAllMocks();
  });

  it("gates debug output behind PI_AZURE_FOUNDRY_DEBUG", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    log.debug("hidden");
    expect(debug).not.toHaveBeenCalled();

    process.env.PI_AZURE_FOUNDRY_DEBUG = "1";
    log.debug("shown");
    expect(debug).toHaveBeenCalledWith("[azure-foundry]", "shown");
  });

  it("emits info, warn, and error with the package prefix", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    log.info("ready");
    log.warn("careful");
    log.error("failed");

    expect(info).toHaveBeenCalledWith("[azure-foundry]", "ready");
    expect(warn).toHaveBeenCalledWith("[azure-foundry]", "careful");
    expect(error).toHaveBeenCalledWith("[azure-foundry]", "failed");
  });
});
