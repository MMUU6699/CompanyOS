'use client';

import { useTranslations } from '@/i18n/use-translations';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useEffect, useState } from 'react';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@kortix/ui/button';
import { Input } from '@kortix/ui/input';
import { FieldError, FieldLabel } from '@kortix/ui/internal/auth/auth-primitives';
import { AuthCardShell, BackToSignIn } from '@kortix/ui/internal/auth/auth-card-shell';
import { resetPassword } from '../actions';

function ResetPasswordContent() {
  const t = useTranslations('auth.passwordReset');
  const router = useRouter();
  const searchParams = useSearchParams();
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash') || searchParams.get('token');
  const type = searchParams.get('type') || 'recovery';

  const [pending, setPending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [hasHashSession, setHasHashSession] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.location.hash) return;
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const accessToken = hashParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token');
    if (!accessToken || !refreshToken) return;
    let active = true;
    createClient()
      .auth.setSession({ access_token: accessToken, refresh_token: refreshToken })
      .then(({ error }) => {
        if (!active) return;
        if (error) {
          setErrorMessage(error.message || t('errors.updateFailed'));
          return;
        }
        setHasHashSession(true);
      })
      .catch(() => {
        if (active) setErrorMessage(t('errors.unexpected'));
      });
    return () => {
      active = false;
    };
  }, [t]);

  const hasRecoveryCredential = Boolean(code || tokenHash || hasHashSession);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMessage(null);
    setPending(true);
    try {
      const result = await resetPassword(null, new FormData(e.currentTarget));
      if (result && typeof result === 'object' && 'success' in result && result.success) {
        const url = new URL(window.location.href);
        url.searchParams.delete('code');
        url.searchParams.delete('token_hash');
        url.searchParams.delete('token');
        url.searchParams.delete('type');
        router.replace(url.pathname + url.search + url.hash);
        setSuccess(true);
        return;
      }
      const msg = (result as any)?.message || t('errors.updateFailed');
      setErrorMessage(msg);
    } catch (err: any) {
      const msg = err?.message || t('errors.unexpected');
      setErrorMessage(msg);
    } finally {
      setPending(false);
    }
  };

  // Link missing / expired — guide the user to request a fresh one instead of
  // dead-ending on an error.
  if (!hasRecoveryCredential && !success) {
    return (
      <AuthCardShell
        title={t('expired.title')}
        description={t('expired.description')}
        footer={<BackToSignIn />}
      >
        <Button asChild size="lg" className="w-full">
          <Link href="/auth/forgot-password">{t('expired.requestNew')}</Link>
        </Button>
      </AuthCardShell>
    );
  }

  if (success) {
    return (
      <AuthCardShell
        title={t('success.title')}
        description={t('success.description')}
        footer={<BackToSignIn />}
      >
        <Button asChild size="lg" className="w-full">
          <Link href="/auth">{t('success.signIn')}</Link>
        </Button>
      </AuthCardShell>
    );
  }

  return (
    <AuthCardShell
      title={t('form.title')}
      description={t('form.description')}
      footer={<BackToSignIn />}
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {tokenHash ? <input type="hidden" name="tokenHash" value={tokenHash} /> : null}
        {tokenHash ? <input type="hidden" name="type" value={type} /> : null}
        {code ? <input type="hidden" name="code" value={code} /> : null}
        <div className="space-y-3">
          <FieldLabel htmlFor="password">{t('form.newPassword')}</FieldLabel>
          <Input
            id="password"
            aria-invalid={!!errorMessage || undefined}
            name="password"
            type="password"
            size="md"
            placeholder={t('form.newPasswordPlaceholder')}
            required
            autoComplete="new-password"
            autoFocus
          />
        </div>
        <div className="space-y-3">
          <FieldLabel htmlFor="confirmPassword">{t('form.confirmPassword')}</FieldLabel>
          <Input
            id="confirmPassword"
            aria-invalid={!!errorMessage || undefined}
            name="confirmPassword"
            type="password"
            size="md"
            placeholder={t('form.confirmPasswordPlaceholder')}
            required
            autoComplete="new-password"
            aria-describedby={errorMessage ? 'password-error' : undefined}
          />
          {errorMessage && <FieldError id="password-error" message={errorMessage} />}
        </div>
        <Button type="submit" size="lg" disabled={pending} className="w-full">
          {pending ? t('form.updating') : t('form.submit')}
        </Button>
      </form>
    </AuthCardShell>
  );
}

export default function ResetPassword() {
  const t = useTranslations('auth.passwordReset');
  return (
    <Suspense fallback={<ConnectingScreen minimal title={t('resetting')} />}>
      <ResetPasswordContent />
    </Suspense>
  );
}
