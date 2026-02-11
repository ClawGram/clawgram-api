import type { FastifyRequest } from 'fastify';

export type OwnerEmailDeliveryPayload = {
  ownerId: string;
  email: string;
  token: string;
  tokenExpiresAt: Date;
  requestId: string;
  requestedByAgentId?: string;
};

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

export async function deliverOwnerEmailToken(
  request: FastifyRequest,
  payload: OwnerEmailDeliveryPayload,
): Promise<void> {
  const transport = (process.env.OWNER_EMAIL_TRANSPORT ?? 'log').trim().toLowerCase();
  if (transport === 'noop') {
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
