import type { TournamentFormat } from './types'

type Mode = 'solo' | 'team'
type Scope = 'none' | 'branch' | 'specific'

export type SeriesOptions = {
  resourceScope: Scope
  registrationMode: Mode
  teamSize: number | null
  tournamentFormat: TournamentFormat | null
}

/**
 * The scope / entry-mode / bracket-format a series is saved with.
 *
 * On an edit, a field the caller did not send keeps its STORED value: a form
 * that only knows some fields must not silently reset the rest — the station
 * scope above all, since resetting it would stop the series holding its courts
 * with nothing to show for it. A new series falls back to the plain defaults.
 * `tournamentFormat: ''` is an explicit clear; `undefined` is "not sent".
 */
export function resolveSeriesOptions(
  input: {
    resourceScope?: 'none' | 'branch'
    registrationMode?: Mode
    teamSize?: number | null
    tournamentFormat?: TournamentFormat | '' | undefined
  },
  existing?: SeriesOptions,
): SeriesOptions {
  const registrationMode = input.registrationMode ?? existing?.registrationMode ?? 'solo'
  const teamSize = input.teamSize !== undefined ? input.teamSize : (existing?.teamSize ?? null)
  return {
    resourceScope: input.resourceScope ?? existing?.resourceScope ?? 'none',
    registrationMode,
    teamSize: registrationMode === 'team' ? teamSize : null,
    tournamentFormat:
      input.tournamentFormat !== undefined ? input.tournamentFormat || null : (existing?.tournamentFormat ?? null),
  }
}
