// Rol ve izin matrisi. Roller şimdilik sabit; Ayarlar'dan özel rol ileride.
import type { Role } from './api-types'

export const PERMISSIONS = [
  'owners.read',
  'owners.write',
  'owners.tckn.view',
  'owners.export',
  'owners.merge',
  'animals.read',
  'animals.write',
  'animals.status',
  'animals.death',
  'chips.implant',
  'chips.correct',
  'visits.read',
  'visits.write',
  'visits.sign',
  'vaccinations.write',
  'petvet.read',
  'petvet.manage',
  'petvet.audit_pack',
  'appointments.read',
  'appointments.write',
  'messages.send',
  'reports.view',
  'reports.export',
  'kvkk.requests',
  'audit.view',
  'settings.manage',
  'users.manage',
  'backup.run',
  'backup.restore',
] as const
export type Permission = (typeof PERMISSIONS)[number]

const ALL = new Set<Permission>(PERMISSIONS)

export const ROLE_PERMISSIONS: Record<Role, Set<Permission>> = {
  admin: ALL,
  vet: new Set<Permission>([
    'owners.read', 'owners.write', 'owners.tckn.view',
    'animals.read', 'animals.write', 'animals.status', 'animals.death',
    'chips.implant', 'chips.correct',
    'visits.read', 'visits.write', 'visits.sign',
    'vaccinations.write',
    'petvet.read', 'petvet.manage', 'petvet.audit_pack',
    'appointments.read', 'appointments.write',
    'messages.send',
    'reports.view',
    'backup.run',
  ]),
  tech: new Set<Permission>([
    'owners.read', 'owners.write',
    'animals.read', 'animals.write',
    'visits.read', 'visits.write',
    'vaccinations.write',
    'petvet.read',
    'appointments.read', 'appointments.write',
  ]),
  secretary: new Set<Permission>([
    'owners.read', 'owners.write', 'owners.tckn.view',
    'animals.read', 'animals.write', 'animals.status',
    'petvet.read', 'petvet.manage',
    'appointments.read', 'appointments.write',
    'messages.send',
    'reports.view',
    'backup.run',
  ]),
}

export function can(role: Role | undefined | null, p: Permission): boolean {
  return !!role && ROLE_PERMISSIONS[role].has(p)
}
