import { describe, it, expect } from "vitest";
import { POND_BOT_USER_AGENT } from "@/shared/pond-bot-user-agent";

describe("POND_BOT_USER_AGENT", () => {
  it("is the PondBot token measurement providers classify as a bot", () => {
    expect(POND_BOT_USER_AGENT).toBe("PondBot/1.0 (+https://pondaudio.app)");
  });

  it("cannot be matched as listener traffic", () => {
    expect(RegExp("^Pond/\\d").test(POND_BOT_USER_AGENT)).toBe(false);
    expect(RegExp("^PondBot/").test(POND_BOT_USER_AGENT)).toBe(true);
  });
});
