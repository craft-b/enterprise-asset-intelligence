// server/services/public-user.ts
//
// The shape of a user as it may leave the server.
//
// /api/auth/me, login and register each returned the row straight from the
// database, bcrypt hash included:
//
//   GET /api/auth/me :: {"id":1,"username":"admin",
//                        "password":"$2b$10$Mt6ks...","role":"ADMINISTRATOR"}
//
// Sent to the browser on every session check, and -- because the request
// logger serialises response bodies -- written into the platform's log
// retention as well. A bcrypt hash at cost 10 is not a plaintext password, but
// it is offline-crackable material that belongs in exactly one place, and
// `admin123` would not survive a wordlist for long.
//
// This is a deliberate allowlist rather than `delete user.password`: a column
// added to the users table later is excluded by default instead of leaking
// until someone notices.

import type { User } from "@shared/schema";

export interface PublicUser {
  id: number;
  username: string;
  role: string;
  createdAt: Date | null;
}

/** Strip a user row down to what a client is allowed to see. */
export function toPublicUser(user: User): PublicUser;
export function toPublicUser(user: User | undefined): PublicUser | undefined;
export function toPublicUser(user: User | undefined): PublicUser | undefined {
  if (!user) return undefined;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt ?? null,
  };
}
