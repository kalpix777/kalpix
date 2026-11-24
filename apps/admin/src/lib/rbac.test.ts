import { describe, expect, it } from "vitest";
import { can, canAssignRole, isAdminRole, toRole } from "./rbac";

describe("rbac", () => {
  it("defaults unknown roles to viewer", () => {
    expect(toRole("superuser")).toBe("viewer");
    expect(toRole(null)).toBe("viewer");
  });
  it("viewer can only read the dashboard", () => {
    expect(can("viewer", "dashboard:read")).toBe(true);
    expect(can("viewer", "settings:write")).toBe(false);
    expect(can("viewer", "audit:read")).toBe(false);
  });
  it("operator cannot manage users or providers", () => {
    expect(can("operator", "users:manage")).toBe(false);
    expect(can("operator", "providers:manage")).toBe(false);
    expect(can("operator", "leads:write")).toBe(true);
  });
  it("admin manages users but cannot create owners", () => {
    expect(can("admin", "users:manage")).toBe(true);
    expect(canAssignRole("admin", "owner")).toBe(false);
    expect(canAssignRole("admin", "operator")).toBe(true);
    expect(canAssignRole("owner", "owner")).toBe(true);
    expect(canAssignRole("operator", "viewer")).toBe(false);
  });
  it("operators start discovery runs; only admins and owners export businesses", () => {
    expect(can("viewer", "discovery:run")).toBe(false);
    expect(can("operator", "discovery:run")).toBe(true);
    expect(can("operator", "businesses:export")).toBe(false);
    expect(can("admin", "businesses:export")).toBe(true);
    expect(can("owner", "businesses:export")).toBe(true);
  });
  it("operators and above start research runs; viewers only read", () => {
    expect(can("viewer", "research:run")).toBe(false);
    expect(can("operator", "research:run")).toBe(true);
    expect(can("admin", "research:run")).toBe(true);
    expect(can("owner", "research:run")).toBe(true);
  });
  it("identifies admin roles for MFA enforcement", () => {
    expect(isAdminRole("owner")).toBe(true);
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("operator")).toBe(false);
  });
});
