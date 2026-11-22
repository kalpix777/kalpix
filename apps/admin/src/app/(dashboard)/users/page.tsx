import { db } from "@/lib/db";
import { ROLES, canAssignRole, toRole } from "@/lib/rbac";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { Flash } from "@/components/flash";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead } from "@/components/ui/table";
import { requirePermission } from "@/server/session";
import { changeRole, createTeamMember, setSuspended } from "@/server/actions/users";

export const metadata = { title: "User Management" };
export const dynamic = "force-dynamic";

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const session = await requirePermission("users:manage");
  const { ok, error } = await searchParams;
  const users = await db.user.findMany({ orderBy: { createdAt: "asc" } });
  const assignable = ROLES.filter((r) => canAssignRole(session.user.role, r));

  return (
    <>
      <PageHeader
        title="User Management"
        description="Public sign-up is off. Team members are added here and must enable MFA if they hold an admin role."
      />
      <Flash ok={ok} error={error} />
      <Card className="mb-6">
        <Table>
          <THead>
            <tr>
              <TH>Name</TH>
              <TH>Role</TH>
              <TH>MFA</TH>
              <TH>Status</TH>
              <TH>Added</TH>
              <TH className="text-right">Actions</TH>
            </tr>
          </THead>
          <TBody>
            {users.map((u) => {
              const self = u.id === session.user.id;
              return (
                <tr key={u.id}>
                  <TD>
                    <span className="block font-medium text-slate-900">
                      {u.name}
                      {self && " (you)"}
                    </span>
                    <span className="text-xs text-slate-500">{u.email}</span>
                  </TD>
                  <TD className="capitalize">{toRole(u.role)}</TD>
                  <TD>
                    {u.twoFactorEnabled ? (
                      <Badge tone="green">On</Badge>
                    ) : (
                      <Badge tone="amber">Off</Badge>
                    )}
                  </TD>
                  <TD>
                    {u.banned ? (
                      <Badge tone="red">Suspended</Badge>
                    ) : (
                      <Badge tone="green">Active</Badge>
                    )}
                  </TD>
                  <TD className="text-xs">{formatDateTime(u.createdAt)}</TD>
                  <TD className="text-right">
                    {!self && (
                      <div className="flex justify-end gap-2">
                        <form action={changeRole} className="flex gap-1.5">
                          <input type="hidden" name="userId" value={u.id} />
                          <Select
                            name="role"
                            defaultValue={toRole(u.role)}
                            aria-label={`Role for ${u.name}`}
                            className="h-8 w-28"
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r} disabled={!assignable.includes(r)}>
                                {r}
                              </option>
                            ))}
                          </Select>
                          <Button type="submit" variant="secondary" className="h-8">
                            Save
                          </Button>
                        </form>
                        <form action={setSuspended}>
                          <input type="hidden" name="userId" value={u.id} />
                          <input type="hidden" name="suspend" value={String(!u.banned)} />
                          <Button
                            type="submit"
                            variant={u.banned ? "secondary" : "ghost"}
                            className="h-8"
                          >
                            {u.banned ? "Restore" : "Suspend"}
                          </Button>
                        </form>
                      </div>
                    )}
                  </TD>
                </tr>
              );
            })}
          </TBody>
        </Table>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Add a team member</CardTitle>
          <CardDescription>
            Set a temporary password (12+ characters) and share it securely, not by email or chat.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={createTeamMember} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="password">Temporary password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                minLength={12}
                required
                autoComplete="new-password"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="role">Role</Label>
              <Select id="role" name="role" defaultValue="viewer">
                {assignable.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </div>
            <div className="sm:col-span-2 lg:col-span-4">
              <Button type="submit">Add member</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
