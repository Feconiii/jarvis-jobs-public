import screen from './screen.mjs';
import discovery from './discovery.mjs';
import writing from './writing.mjs';

/** What setup shows and seeds for someone who picks this preset. */
const meta = {
  id: 'hardware-engineering',
  label: 'Hardware / mechanical engineering (semiconductor, robotics, aerospace, manufacturing)',
  defaultTargetRoles: [
    'Mechanical Engineer', 'Manufacturing Engineer', 'Automation Engineer',
    'Process Engineer', 'Equipment Engineer', 'Robotics Engineer',
  ],
  // Company names setup hands to the board finder when portals.yml is empty.
  starterCompanies: [
    'Applied Materials', 'Lam Research', 'KLA', 'Micron', 'Tesla', 'Boston Dynamics',
    'Intuitive', 'Zoox', 'Anduril', 'Rivian', 'Formlabs', 'ASML',
  ],
  // The board finder's S&P pass for this field.
  spSectors: 'Industrials,Information Technology,Health Care,Energy,Materials',
  // Words setup writes into a new preferences file.
  starterPreferences: [
    'avoid senior, staff, principal, lead, manager, director in title',
    'never intern, internship, co-op in title',
  ],
};

export default { meta, screen, discovery, writing };
