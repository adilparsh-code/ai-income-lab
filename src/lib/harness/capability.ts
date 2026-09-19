// Phase 4.3 — unified external harness capability surface.
//
// This is intentionally separate from the existing Ruflo-specific capability
// endpoint. It gives the application one internal model for multiple trusted
// orchestration runtimes without pretending either runtime is connected.

import { describeRufloIntegration } from '@/lib/ruflo/capability';
import { describePrimeAgent } from './prime-connector';
import type { HarnessCapability } from './types';

export function describeHarnessCapabilities(): HarnessCapability[] {
  const ruflo = describeRufloIntegration();
  const prime = describePrimeAgent();

  return [
    {
      id: 'ruflo',
      name: 'Ruflo',
      status:
        ruflo.status === 'RUFLO_CONNECTED'
          ? 'CONNECTED'
          : ruflo.status === 'RUFLO_READY'
            ? 'READY'
            : 'NOT_CONNECTED',
      detail: ruflo.detail,
      externalRuntimeRequired: true,
      preservesApplicationGates: true,
    },
    {
      id: 'prime-agent',
      name: 'Prime Agent',
      status: prime.status,
      detail: prime.detail,
      externalRuntimeRequired: true,
      preservesApplicationGates: true,
    },
  ];
}

export function allHarnessesConnected(): boolean {
  return describeHarnessCapabilities().every((harness) => harness.status === 'CONNECTED');
}
