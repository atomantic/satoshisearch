import type { PageServerLoad, Actions } from './$types';
import { fail } from '@sveltejs/kit';
import { grinder } from '$server/grinder/engine';
import { makeSource, listSources } from '$server/grinder/registry';
import { loadMatchSet } from '$server/grinder/loadset';
import { config } from '$server/config';

export const load: PageServerLoad = async () => {
  const set = loadMatchSet();
  return {
    status: grinder.status,
    vaultReady: grinder.vaultReady,
    sources: listSources(),
    matchSet: { hash160s: set.hash160s.size, pubkeys: set.pubkeys.size, size: set.size },
    policy: {
      dryRun: config.rescue.dryRun,
      autoBuckets: [...config.rescue.autoBuckets],
      whitehatAttested: config.rescue.whitehatAttested,
      destConfigured: !!config.rescue.destAddress
    }
  };
};

export const actions: Actions = {
  start: async ({ request }) => {
    const data = await request.formData();
    const id = String(data.get('source') ?? '');
    const source = makeSource(id);
    if (!source) return fail(400, { error: `unknown or unavailable source: ${id}` });
    await grinder.start(source);
    return { started: source.name };
  },
  stop: async () => {
    await grinder.stop();
    return { stopped: true };
  }
};
