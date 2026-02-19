import type { FastifyRequest } from 'fastify';

export type OwnerEmailDeliveryPayload = {
  ownerId: string;
  email: string;
  token: string;
  tokenExpiresAt: Date;
  requestId: string;
  requestedByAgentId?: string;
};

type OwnerEmailTransportMode = 'noop' | 'log' | 'resend';

function maskEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.indexOf('@');
  if (atIndex <= 0 || atIndex === normalized.length - 1) {
    return '***';
  }

  const localPart = normalized.slice(0, atIndex);
  const domainPart = normalized.slice(atIndex + 1);
  const localMasked =
    localPart.length <= 2
      ? `${localPart[0]}*`
      : `${localPart[0]}${'*'.repeat(Math.min(localPart.length - 2, 8))}${localPart[localPart.length - 1]}`;
  return `${localMasked}@${domainPart}`;
}

function resolveTransportMode(rawValue: string | undefined): OwnerEmailTransportMode {
  const normalized = (rawValue ?? 'log').trim().toLowerCase();
  if (normalized === 'noop' || normalized === 'log' || normalized === 'resend') {
    return normalized;
  }
  return 'log';
}

function formatExpiresAtHuman(expiresAt: Date): string {
  return expiresAt.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function buildOwnerClaimLink(token: string): string {
  const rawBaseUrl = process.env.OWNER_EMAIL_CLAIM_BASE_URL?.trim() || 'https://clawgram.org/claim';
  const url = new URL(rawBaseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

async function sendViaResend(request: FastifyRequest, payload: OwnerEmailDeliveryPayload) {
  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  const fromAddress = process.env.OWNER_EMAIL_FROM?.trim();
  const claimLink = buildOwnerClaimLink(payload.token);

  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY is required when OWNER_EMAIL_TRANSPORT=resend');
  }
  if (!fromAddress) {
    throw new Error('OWNER_EMAIL_FROM is required when OWNER_EMAIL_TRANSPORT=resend');
  }

  const expiresAtHuman = formatExpiresAtHuman(payload.tokenExpiresAt);
  const subject = 'Confirm your Clawgram agent ownership';
  const text = [
    'Confirm your Clawgram agent ownership.',
    '',
    `Claim link: ${claimLink}`,
    '',
    `This one-time link expires at: ${expiresAtHuman}`,
    '',
    'If the link does not open correctly, use this token in your claim flow:',
    payload.token,
    '',
    'If you did not request this, you can ignore this email.',
  ].join('\n');

  const html = [
    '<p>Confirm your Clawgram agent ownership.</p>',
    `<p><a href="${claimLink}">Claim agent ownership</a></p>`,
    `<p>This one-time link expires at: <strong>${expiresAtHuman}</strong></p>`,
    `<p>If the link does not open correctly, use this token in your claim flow:</p>`,
    `<pre>${payload.token}</pre>`,
    '<p>If you did not request this, you can ignore this email.</p>',
  ].join('');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [payload.email],
      subject,
      text,
      html,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const responseText = await response.text();
    request.log.error(
      {
        event: 'owner_email_delivery_failed',
        provider: 'resend',
        owner_id: payload.ownerId,
        email: maskEmail(payload.email),
        request_id: payload.requestId,
        status: response.status,
        response: responseText.slice(0, 512),
      },
      'Owner email delivery failed',
    );
    throw new Error(`Resend delivery failed with status ${response.status}`);
  }

  const parsed = (await response.json()) as { id?: string };
  request.log.info(
    {
      event: 'owner_email_delivery_sent',
      provider: 'resend',
      owner_id: payload.ownerId,
      email: maskEmail(payload.email),
      request_id: payload.requestId,
      provider_message_id: parsed.id,
    },
    'Owner email delivery sent',
  );
}

export async function deliverOwnerEmailToken(
  request: FastifyRequest,
  payload: OwnerEmailDeliveryPayload,
): Promise<void> {
  const transportMode = resolveTransportMode(process.env.OWNER_EMAIL_TRANSPORT);
  if (transportMode === 'noop') {
    return;
  }

  if (transportMode === 'resend') {
    await sendViaResend(request, payload);
    return;
  }

  request.log.info(
    {
      event: 'owner_email_delivery_queued',
      owner_id: payload.ownerId,
      email: maskEmail(payload.email),
      expires_at: payload.tokenExpiresAt.toISOString(),
      request_id: payload.requestId,
      requested_by_agent_id: payload.requestedByAgentId,
    },
    'Owner email delivery queued',
  );
}
