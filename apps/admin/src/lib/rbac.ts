export const ROLES = ["owner", "admin", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "dashboard:read",
  "audit:read",
  "users:manage",
  "settings:write",
  "providers:manage",
  "pricing:manage",
  "leads:write",
  "discovery:run",
  "research:run",
  "businesses:export",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MATRIX: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: [
    "dashboard:read",
    "audit:read",
    "users:manage",
    "settings:write",
    "providers:manage",
    "pricing:manage",
    "leads:write",
    "discovery:run",
    "research:run",
    "businesses:export",
  ],
  operator: ["dashboard:read", "leads:write", "discovery:run", "research:run"],
  viewer: ["dashboard:read"],
};

export function toRole(value: string | null | undefined): Role {
  return (ROLES as readonly string[]).includes(value ?? "") ? (value as Role) : "viewer";
}

export function can(role: string | null | undefined, permission: Permission): boolean {
  return MATRIX[toRole(role)].includes(permission);
}

export function isAdminRole(role: string | null | undefined): boolean {
  const r = toRole(role);
  return r === "owner" || r === "admin";
}

/** Only an owner may grant or remove the owner role; admins may manage operator/viewer/admin. */
export function canAssignRole(actorRole: string | null | undefined, target: Role): boolean {
  const a = toRole(actorRole);
  if (a === "owner") return true;
  if (a === "admin") return target !== "owner";
  return false;
}
