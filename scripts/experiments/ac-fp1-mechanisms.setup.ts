import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { ActionCompilationCodec, actionCompilationProfileKinds } from "../../src/engine/algorithms/eager-reference/action-compilation-representation";
import * as compiler from "../../src/engine/algorithms/eager-reference/action-compiler";

const compile = compiler.compileActions;
let roundTrips = 0;
let invalidCanonicalFixtures = 0;
beforeEach(() => {
  vi.spyOn(compiler, "compileActions").mockImplementation(async (provider, state, ...args) => compile({
    catalog: provider.catalog,
    availableProfileSummaries: (role) => provider.availableProfileSummaries(role),
    assertProfilesAvailable: (ids) => provider.assertProfilesAvailable(ids),
    async generateStructured(request) {
      const generated = await provider.generateStructured(request);
      const codec = new ActionCompilationCodec("AT", request.context, request.context, actionCompilationProfileKinds(state));
      let restored: unknown;
      try { restored = codec.decodeOutput(codec.encodeOutput(generated.value)); }
      catch (error) {
        // The bijection is defined for legal canonical references, not an
        // intentionally nonexistent key in a negative fixture. Keep that
        // invalid response untouched so the real slot validator still rejects
        // it and retains valid siblings. Live unknown aliases have separate
        // actual-gateway rejection/repair tests.
        if (!(error instanceof Error) || !/^root alias namespace does not include repair candidate candidate_[0-9a-f]{12}$/u.test(error.message)) throw error;
        invalidCanonicalFixtures++;
        return generated;
      }
      expect(restored).toEqual(generated.value);
      roundTrips++;
      // Only the scripted model output is represented. The original compiler,
      // scheduler, mechanics, Truth verification and kernel remain unchanged.
      return { ...generated, value: request.schema.parse(restored) };
    },
  }, state, ...args));
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { if (roundTrips || invalidCanonicalFixtures) process.stdout.write(`AC_FP1_CODEC_KERNEL_ROUNDTRIPS ${roundTrips}; INVALID_CANONICAL_FIXTURES ${invalidCanonicalFixtures}\n`); });
