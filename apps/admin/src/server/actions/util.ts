import "server-only";
import { redirect } from "next/navigation";
import { ZodError } from "zod";

/** Runs a mutation and redirects back with ?ok= or ?error= so the page can show the outcome. */
export async function runAction(
  path: string,
  okMessage: string,
  fn: () => Promise<void>,
): Promise<never> {
  let target: string;
  try {
    await fn();
    target = `${path}?ok=${encodeURIComponent(okMessage)}`;
  } catch (err) {
    const msg =
      err instanceof ZodError
        ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        : err instanceof Error
          ? err.message
          : "Unexpected error";
    target = `${path}?error=${encodeURIComponent(msg)}`;
  }
  redirect(target);
}
