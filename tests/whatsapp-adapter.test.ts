import { describe, it, expect } from "bun:test";
import { isGroupJid, getPhoneFromJid } from "../src/gateway/whatsapp/users";

describe("whatsapp users", () => {
  it("detects group JID", () => {
    expect(isGroupJid("1234567890@g.us")).toBe(true);
    expect(isGroupJid("1234567890@s.whatsapp.net")).toBe(false);
  });

  it("extracts phone from individual JID", () => {
    expect(getPhoneFromJid("1234567890@s.whatsapp.net")).toBe("1234567890");
  });

  it("extracts ID from group JID", () => {
    expect(getPhoneFromJid("123456789-987654321@g.us")).toBe("123456789-987654321");
  });
});
