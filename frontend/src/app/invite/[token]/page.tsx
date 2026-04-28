"use client";

import { FormEvent, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowRight, Mail, UserRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { invitesApi } from "@/lib/api/endpoints";
import { saveTokens } from "@/lib/auth";

export default function ChannelInvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const result = await invitesApi.redeem(token, email || undefined, displayName || undefined);
      saveTokens(result.tokens);
      router.replace("/w");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invite could not be redeemed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-app px-4 py-10 text-ink">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5">
        <div>
          <h1 className="text-2xl font-semibold">Join workspace channel</h1>
          <p className="mt-1 text-sm text-ink-3">Create your guest profile to open the invited channel.</p>
        </div>

        <div className="space-y-3">
          <Field label="Email">
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
              <Input
                className="pl-9"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
              />
            </div>
          </Field>
          <Field label="Display name">
            <div className="relative">
              <UserRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
              <Input
                className="pl-9"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
              />
            </div>
          </Field>
        </div>

        {error ? (
          <div className="rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200">
            {error}
          </div>
        ) : null}

        <Button type="submit" className="w-full justify-center" loading={loading}>
          Continue <ArrowRight className="h-4 w-4" />
        </Button>
      </form>
    </main>
  );
}
