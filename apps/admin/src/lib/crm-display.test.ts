import { describe, expect, it } from "vitest";
import {
  crmQuery,
  formatInr,
  isConflictMessage,
  paiseToRupeesInput,
  stageLabel,
  toIstInput,
} from "./crm-display";

describe("crm display helpers", () => {
  it("labels stages", () => {
    expect(stageLabel("demo_requested")).toBe("Demo requested");
    expect(stageLabel("new")).toBe("New");
  });
  it("builds list query strings and drops blanks", () => {
    expect(crmQuery({})).toBe("");
    expect(crmQuery({ stage: "new", overdue: true, q: "dosa" })).toBe(
      "?stage=new&overdue=yes&q=dosa",
    );
    expect(crmQuery({ stage: "new", page: 3 }, { page: "4" })).toBe("?stage=new&page=4");
    expect(crmQuery({ stage: "new" }, { stage: undefined })).toBe("");
  });
  it("formats datetime-local values in IST", () => {
    expect(toIstInput(new Date("2026-11-26T04:30:00Z"))).toBe("2026-11-26T10:00");
    expect(toIstInput(null)).toBe("");
    expect(toIstInput("not a date")).toBe("");
  });
  it("shows paise as rupees", () => {
    expect(paiseToRupeesInput(1234550)).toBe("12345.50");
    expect(paiseToRupeesInput(2500000)).toBe("25000");
    expect(paiseToRupeesInput(null)).toBe("");
    expect(formatInr(2500000)).toBe("₹25,000");
    expect(formatInr(1234550)).toBe("₹12,345.50");
    expect(formatInr(null)).toBe("—");
  });
  it("recognises the 409 conflict message", () => {
    expect(isConflictMessage("This lead was changed by someone else. Reload and try again.")).toBe(
      true,
    );
    expect(isConflictMessage("Nope")).toBe(false);
    expect(isConflictMessage(undefined)).toBe(false);
  });
});
