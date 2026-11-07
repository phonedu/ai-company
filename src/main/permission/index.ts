/** `src/main/permission` 公共出口（OPT-M9-1 权限闸门）。 */
export {
  permissionGate,
  detectEgressCommand,
  detectGitWriteCommand,
  toolCategory,
  downgradeAutonomy,
  type PermissionDecision,
  type CapabilityTier,
  type Autonomy,
  type ToolCategory,
  type ToolCall,
  type PermissionPolicy,
  type GateContext,
  type GateResult,
} from './gate.js';
