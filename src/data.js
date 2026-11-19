// Deterministic VM inventory. The first four records are the exact sample from the
// requirement; the rest are generated with realistic variety and deliberate dirty
// data so every transform / reject / normalization rule in ServiceNow gets exercised.
//
// Each record carries an internal `_updated_at` used for the updated_since filter.
// Fields starting with "_" are never returned by the API.

const DAY = 24 * 60 * 60 * 1000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SAMPLE_VMS = [
  {
    vm_id: 'vm-001',
    hostname: ' WEB-PROD-01 ',
    ip_address: '10.10.1.11',
    cpu_count: 4,
    ram_gb: 16,
    disk_gb: 256,
    environment: 'Production',
    owner_email: 'alice@acme.com',
    cost_center: 'CC100',
    status: 'running',
    last_seen: '2026-11-18T22:10:00Z',
    guest_os: { family: 'Linux', name: 'Ubuntu', version: '22.04', kernel: '5.15.0-91' },
    installed_software: [
      { name: 'nginx', publisher: 'F5', version: '1.24.0', install_date: '2026-03-10' },
      { name: 'OpenSSL', publisher: 'OpenSSL Project', version: '3.0.2', install_date: '2026-01-05' },
    ],
  },
  {
    vm_id: 'vm-002',
    hostname: 'app-win-07',
    ip_address: '10.20.3.7',
    cpu_count: 2,
    cpu_manufacturer: 'Intel Corporation',
    manufacturer: 'VMware, Inc.',
    model: 'VMware Virtual Platform',
    ram_gb: 8,
    environment: 'Development',
    owner_email: 'unknown@acme.com',
    status: 'stopped',
    last_seen: '2026-11-17T08:45:00Z',
    guest_os: { family: 'Windows', name: 'Windows Server', version: '2022' },
    installed_software: [
      { name: 'Microsoft SQL Server', publisher: 'Microsoft', version: '2019', install_date: '2026-02-14' },
    ],
  },
  {
    // Duplicate of vm-001 by hostname (after trim/lowercase) and IP: tests IRE behaviour.
    vm_id: 'vm-003',
    hostname: 'web-prod-01',
    ip_address: '10.10.1.11',
    status: 'running',
    guest_os: { family: 'Linux' },
  },
  {
    // Must be rejected: empty hostname and invalid IPv4.
    vm_id: 'vm-004',
    hostname: '',
    ip_address: '999.1.1.1',
    status: 'running',
  },
];

// ---- Generator catalogs ------------------------------------------------------

const OS_PROFILES = {
  linux: [
    { family: 'Linux', name: 'Ubuntu', version: '22.04', kernel: '5.15.0-91' },
    { family: 'Linux', name: 'ubuntu', version: '20.04', kernel: '5.4.0-150' },
    { family: 'Linux', name: 'Ubuntu Server', version: '24.04', kernel: '6.8.0-45' },
    { family: 'Linux', name: 'Red Hat Enterprise Linux', version: '8.9', kernel: '4.18.0-513.el8' },
    { family: 'Linux', name: 'RHEL', version: '9.3', kernel: '5.14.0-362.el9' },
    { family: 'linux', name: 'CentOS', version: '7.9', kernel: '3.10.0-1160' },
    { family: 'Linux', name: 'Amazon Linux', version: '2023', kernel: '6.1.61-85' },
    { family: 'LINUX', name: 'SUSE Linux Enterprise Server', version: '15 SP5', kernel: '5.14.21-150500' },
    { family: 'Linux', name: 'Debian', version: '12', kernel: '6.1.0-13' },
    { family: 'Linux' }, // family only
  ],
  windows: [
    { family: 'Windows', name: 'Windows Server', version: '2022' },
    { family: 'Windows', name: 'Win Server 2022', version: '2022' },
    { family: 'windows', name: 'Microsoft Windows Server 2019 Datacenter', version: '10.0.17763' },
    { family: 'Windows', name: 'Windows Server', version: '2016' },
    { family: 'WINDOWS', name: 'Win2019', version: '2019' },
    { family: 'Windows', name: 'Windows Server 2022 Standard', version: '21H2' },
    { family: 'Windows' }, // family only
  ],
  unknown: [
    { family: 'FreeBSD', name: 'FreeBSD', version: '13.2', kernel: '13.2-RELEASE' },
    { family: 'Solaris', name: 'Oracle Solaris', version: '11.4' },
    { family: '', name: 'Unknown' },
    { name: 'Appliance OS' }, // family missing
    null, // guest_os missing entirely
  ],
};

const SOFTWARE = {
  linux: [
    { name: 'nginx', publisher: 'F5', versions: ['1.24.0', '1.25.3', '1.22.1'] },
    { name: 'OpenSSL', publisher: 'OpenSSL Project', versions: ['3.0.2', '3.0.13', '1.1.1w'] },
    { name: 'PostgreSQL', publisher: 'PostgreSQL Global Development Group', versions: ['15.5', '16.1', '14.10'] },
    { name: 'Docker Engine', publisher: 'Docker, Inc.', versions: ['24.0.7', '25.0.3'] },
    { name: 'Apache HTTP Server', publisher: 'Apache Software Foundation', versions: ['2.4.58', '2.4.57'] },
    { name: 'OpenJDK', publisher: 'Eclipse Adoptium', versions: ['17.0.9', '21.0.1', '11.0.21'] },
    { name: 'Python', publisher: 'Python Software Foundation', versions: ['3.10.12', '3.11.6', '3.12.1'] },
    { name: 'Datadog Agent', publisher: 'Datadog', versions: ['7.49.1', '7.50.0'] },
  ],
  windows: [
    { name: 'Microsoft SQL Server', publisher: 'Microsoft', versions: ['2019', '2022', '2017'] },
    { name: 'Microsoft .NET Framework', publisher: 'Microsoft Corporation', versions: ['4.8', '4.8.1'] },
    { name: 'IIS', publisher: 'Microsoft', versions: ['10.0'] },
    { name: 'Google Chrome', publisher: 'Google LLC', versions: ['119.0.6045.160', '120.0.6099.71'] },
    { name: 'Notepad++', publisher: 'Notepad++ Team', versions: ['8.5.8', '8.6'] },
    { name: '7-Zip', publisher: 'Igor Pavlov', versions: ['23.01', '22.01'] },
    { name: 'CrowdStrike Falcon Sensor', publisher: 'CrowdStrike, Inc.', versions: ['7.05.17706', '7.06.17807'] },
  ],
};

const PROVIDERS = [
  { cloud_provider: 'aws', regions: ['us-east-1', 'us-west-2', 'eu-west-1'], manufacturer: 'Amazon EC2', models: ['t3.large', 'm5.xlarge', 'c6i.2xlarge'] },
  { cloud_provider: 'AWS', regions: ['us-east-1', 'ap-south-1'], manufacturer: 'Amazon.com, Inc.', models: ['m5.large', 'r5.xlarge'] },
  { cloud_provider: 'azure', regions: ['eastus', 'westeurope', 'centralindia'], manufacturer: 'Microsoft Corporation', models: ['Virtual Machine', 'Standard_D4s_v5'] },
  { cloud_provider: 'gcp', regions: ['us-central1', 'europe-west1'], manufacturer: 'Google', models: ['Google Compute Engine', 'e2-standard-4'] },
  { cloud_provider: 'vmware', regions: ['dc-chennai-01', 'dc-dallas-02'], manufacturer: 'VMware, Inc.', models: ['VMware Virtual Platform', 'VMware7,1'] },
];

const CPU_MANUFACTURERS = [
  'Intel Corporation', 'GenuineIntel', 'intel', 'Intel(R) Corporation',
  'AuthenticAMD', 'AMD', 'Advanced Micro Devices, Inc.', 'amd',
];

const ENVIRONMENTS = [
  'Production', 'Production', 'Prod', 'PROD', 'production',
  'Development', 'Dev', 'DEV',
  'QA', 'Test', 'UAT', 'Staging', 'stage',
  'DR', 'Sandbox', // likely unmapped in the lookup table
];

const OWNERS = [
  'alice@acme.com', 'bob@acme.com', 'carol@acme.com', 'dave@acme.com', 'erin@acme.com',
  'ALICE@ACME.COM', ' bob@acme.com ', // case / whitespace variants
  'unknown@acme.com', 'former.employee@acme.com', // not in sys_user
];

const COST_CENTERS = ['CC100', 'CC200', 'CC300', 'CC400', 'CC999', 'cc100'];

const STATUSES = [
  'running', 'running', 'running', 'running', 'running', 'running',
  'stopped', 'stopped', 'stopped',
  'terminated', 'suspended', 'pending', // unmapped → should be logged
];

const ROLES = ['web', 'app', 'db', 'api', 'cache', 'batch', 'mq', 'jump', 'k8s-node', 'etl'];
const ENV_CODE = { prod: 'prod', dev: 'dev', test: 'qa', other: 'misc' };

const INVALID_IPS = ['999.1.1.1', '256.10.0.1', '10.0.0', '10.0.0.1.5', 'not-an-ip', '', 'fe80::1', '10.0.0.01a'];
const EMPTY_HOSTNAMES = ['', '   ', null];

// ---- Generator ---------------------------------------------------------------

export function buildInventory({ count, seed, now = Date.now() }) {
  const r = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const chance = (p) => r() < p;
  const int = (min, max) => min + Math.floor(r() * (max - min + 1));
  const isoDaysAgo = (maxDays) => new Date(now - r() * maxDays * DAY);

  const vms = SAMPLE_VMS.map((vm, i) => ({
    ...structuredClone(vm),
    // Samples look recently changed so every delta window includes them.
    _updated_at: new Date(now - (i + 1) * 60 * 60 * 1000).toISOString(),
  }));

  const hostnames = vms.map((v) => (v.hostname || '').trim().toLowerCase()).filter(Boolean);

  for (let n = vms.length + 1; n <= count; n++) {
    const vm_id = `vm-${String(n).padStart(3, '0')}`;
    const roll = r();
    const osKind = roll < 0.55 ? 'linux' : roll < 0.9 ? 'windows' : 'unknown';
    const provider = pick(PROVIDERS);
    const env = pick(ENVIRONMENTS);
    const envKey = /prod/i.test(env) ? 'prod' : /dev/i.test(env) ? 'dev' : /qa|test|uat|stag/i.test(env) ? 'test' : 'other';

    // Hostname
    let hostname = `${pick(ROLES)}-${osKind === 'windows' ? 'win-' : ''}${ENV_CODE[envKey]}-${String(int(1, 99)).padStart(2, '0')}`;
    if (chance(0.03) && hostnames.length) hostname = pick(hostnames); // duplicate hostname, different vm_id
    if (chance(0.1)) hostname = ` ${hostname.toUpperCase()} `; // needs trim + lowercase
    if (chance(0.02)) hostname = pick(EMPTY_HOSTNAMES); // → reject
    if (hostname) hostnames.push(hostname.trim().toLowerCase());

    // IP
    let ip_address = `10.${int(0, 60)}.${int(0, 255)}.${int(1, 254)}`;
    if (chance(0.025)) ip_address = pick(INVALID_IPS); // → reject

    const vm = { vm_id, hostname, ip_address };
    if (hostname === null) delete vm.hostname;

    vm.cloud_provider = provider.cloud_provider;
    vm.region = pick(provider.regions);
    vm.cpu_count = pick([1, 2, 2, 4, 4, 8, 16, 32]);
    if (chance(0.7)) vm.cpu_manufacturer = pick(CPU_MANUFACTURERS);
    if (chance(0.8)) vm.manufacturer = chance(0.1) ? provider.manufacturer.toUpperCase() : provider.manufacturer;
    if (chance(0.75)) vm.model = pick(provider.models);
    vm.ram_gb = pick([0.5, 1, 2, 4, 8, 8, 16, 16, 32, 64, 128]);
    if (chance(0.85)) vm.disk_gb = pick([30, 50, 64, 100, 128, 256, 500, 1024]);
    if (chance(0.95)) vm.environment = env;
    if (chance(0.9)) vm.owner_email = pick(OWNERS);
    if (chance(0.85)) vm.cost_center = pick(COST_CENTERS);
    vm.status = pick(STATUSES);
    if (chance(0.97)) {
      const d = isoDaysAgo(30);
      // Mix of valid ISO 8601 shapes.
      vm.last_seen = chance(0.8)
        ? d.toISOString().replace(/\.\d{3}Z$/, 'Z')
        : chance(0.5)
          ? d.toISOString()
          : d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
    }

    const os = pick(OS_PROFILES[osKind]);
    if (os !== null) vm.guest_os = structuredClone(os);

    // Installed software (only for Linux/Windows).
    if (osKind !== 'unknown' && chance(0.85)) {
      const catalog = SOFTWARE[osKind];
      const picks = new Set();
      const total = int(1, 5);
      while (picks.size < total) picks.add(pick(catalog));
      vm.installed_software = [...picks].map((sw) => ({
        name: sw.name,
        publisher: sw.publisher,
        version: pick(sw.versions),
        install_date: new Date(now - int(10, 400) * DAY).toISOString().slice(0, 10),
      }));
      // Exact duplicate entry in the same payload: upsert must stay idempotent.
      if (chance(0.05)) vm.installed_software.push({ ...vm.installed_software[0] });
    }

    vm._updated_at = isoDaysAgo(30).toISOString();
    vms.push(vm);
  }

  return vms;
}

export function publicView(vm) {
  const out = {};
  for (const [k, v] of Object.entries(vm)) if (!k.startsWith('_')) out[k] = v;
  return out;
}
