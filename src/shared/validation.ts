import { z } from 'zod';
import { isCalendarDate, isValidPeriod } from './period';
import type { AppConfig, Period } from './types';

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isCalendarDate, 'Data inválida');
const member = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  externalLogin: z
    .string()
    .max(200)
    .regex(/^[a-zA-Z0-9_-]*$/, 'Login GitHub inválido'),
});
export const configSchema = z
  .object({
    version: z.literal(1),
    workspace: z.object({
      id: z.string().min(1),
      name: z.string().min(1).max(100),
      members: z.array(member).min(1).max(100),
    }),
    organizations: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/)).max(100),
    githubHost: z
      .string()
      .regex(/^[a-zA-Z0-9.-]+$/)
      .min(1),
    gitlab: z
      .object({
        enabled: z.boolean(),
        host: z
          .string()
          .min(1)
          .max(253)
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/),
        projects: z
          .array(
            z
              .string()
              .max(500)
              .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/),
          )
          .max(100),
        cli: z.string().min(1).max(2000),
        commitEmails: z.array(z.email()).max(30).optional(),
        username: z
          .string()
          .max(200)
          .regex(/^[a-zA-Z0-9_.-]*$/),
      })
      .refine(
        (v) => !v.enabled || (v.projects.length > 0 && !!v.username),
        'GitLab: informe usuário e pelo menos um projeto.',
      )
      .optional(),
    bitbucket: z
      .object({
        enabled: z.boolean(),
        repositories: z
          .array(
            z
              .string()
              .max(500)
              .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
          )
          .max(100),
        email: z.union([z.literal(''), z.email()]),
        tokenFile: z.string().max(2000),
        accountId: z
          .string()
          .max(200)
          .regex(/^[a-zA-Z0-9{}:_-]*$/),
      })
      .refine(
        (v) =>
          !v.enabled ||
          (v.repositories.length > 0 && !!v.email && v.tokenFile.startsWith('/') && !!v.accountId),
        'Bitbucket: informe repositórios, e-mail, ID da conta e caminho absoluto do arquivo do token.',
      )
      .optional(),
    azure: z.object({
      enabled: z.boolean(),
      organization: z.string().max(500),
      projects: z.array(z.string().min(1).max(200)),
    }),
    cli: z.object({
      gh: z.string().min(1).max(2000),
      az: z.string().min(1).max(2000),
      codex: z.string().min(1).max(2000),
    }),
    codexSessionsPath: z.string().min(1).max(2000),
    claudeSessionsPath: z.string().min(1).max(2000).optional(),
    repoMappings: z.record(z.string(), z.string()),
    calendar: z.object({
      timezone: z.string().refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Fuso inválido'),
      workdays: z.array(z.number().int().min(0).max(6)).min(1),
      automaticHolidays: z.boolean(),
      excludedDates: z.array(date),
      holidays: z.record(date, z.string()),
      automaticHolidayDates: z.record(date, z.string()).optional(),
    }),
    syncMinutes: z.number().int().min(1).max(1440),
    analysis: z.object({
      enabled: z.boolean(),
      model: z.string().min(1).max(100),
      includeDiffs: z.boolean(),
    }),
    reducedMotion: z.boolean(),
    launchAtLogin: z.boolean(),
    onboardingComplete: z.boolean(),
  })
  .refine(
    (value) =>
      !value.onboardingComplete ||
      !value.organizations.length ||
      Boolean(value.workspace.members[0]?.externalLogin),
    'Preencha seu login GitHub para importar as organizações.',
  );
export const periodSchema = z
  .object({ start: date, end: date, rolling: z.boolean().optional() })
  .refine(isValidPeriod, 'Período inválido (máximo de dez anos)');
export function validateConfig(value: unknown): AppConfig {
  return configSchema.parse(value);
}
export function validatePeriod(value: unknown): Period {
  return periodSchema.parse(value);
}
