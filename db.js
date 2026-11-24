const STORAGE_PREFIX = "policytrack:v1:";
const collections = ["clients", "familyMembers", "policies", "followUps"];
const fields = {
  clients: ["id", "name", "phone", "dob", "occupation", "agentName"],
  familyMembers: ["id", "clientId", "name", "phone", "relation", "dob", "occupation"],
  policies: ["id", "clientId", "policyNumber", "provider", "premiumAmount", "sumInsured", "renewalDate"],
  followUps: ["id", "clientId", "note", "followUpDate", "isCompleted"]
};

function isValidDate(value, optional = false) {
  if (optional && value === "") return true;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) return false;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function requireString(record, key, collectionName, index, required = false) {
  const value = record[key];
  if (typeof value !== "string" || (required && !value.trim())) {
    throw new Error(`Backup record ${index + 1} in ${collectionName} has an invalid ${key} field.`);
  }
  if (key === "id" && value.includes("/")) {
    throw new Error(`Backup record ${index + 1} in ${collectionName} has an invalid id field.`);
  }
}

function validateRecord(record, collectionName, index) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error(`Backup record ${index + 1} in ${collectionName} must be an object.`);
  }
  const expected = fields[collectionName].slice().sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, keyIndex) => key !== expected[keyIndex])) {
    throw new Error(`Backup record ${index + 1} in ${collectionName} does not match the PolicyTrack data model.`);
  }
  const requiredStrings = {
    clients: ["id", "name", "phone", "agentName"],
    familyMembers: ["id", "clientId", "name", "relation"],
    policies: ["id", "clientId", "policyNumber", "provider"],
    followUps: ["id", "clientId", "note"]
  }[collectionName];
  for (const key of fields[collectionName].filter((fieldName) => !["premiumAmount", "sumInsured", "isCompleted"].includes(fieldName))) {
    requireString(record, key, collectionName, index, requiredStrings.includes(key));
  }
  if (collectionName === "clients" && !isValidDate(record.dob, true)) throw new Error(`Backup record ${index + 1} in clients has an invalid dob date.`);
  if (collectionName === "familyMembers") {
    if (!["Spouse", "Child", "Parent"].includes(record.relation)) throw new Error(`Backup record ${index + 1} in familyMembers has an invalid relation.`);
    if (!isValidDate(record.dob, true)) throw new Error(`Backup record ${index + 1} in familyMembers has an invalid dob date.`);
  }
  if (collectionName === "policies") {
    if (typeof record.premiumAmount !== "number" || !Number.isFinite(record.premiumAmount) || record.premiumAmount < 0) throw new Error(`Backup record ${index + 1} in policies has an invalid premiumAmount field.`);
    if (typeof record.sumInsured !== "number" || !Number.isFinite(record.sumInsured) || record.sumInsured < 0) throw new Error(`Backup record ${index + 1} in policies has an invalid sumInsured field.`);
    if (!isValidDate(record.renewalDate)) throw new Error(`Backup record ${index + 1} in policies has an invalid renewalDate date.`);
  }
  if (collectionName === "followUps") {
    if (typeof record.isCompleted !== "boolean") throw new Error(`Backup record ${index + 1} in followUps has an invalid isCompleted field.`);
    if (!isValidDate(record.followUpDate)) throw new Error(`Backup record ${index + 1} in followUps has an invalid followUpDate date.`);
  }
  return Object.fromEntries(fields[collectionName].map((key) => [key, record[key]]));
}

export function validateWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
    throw new Error("The backup must contain a PolicyTrack workspace object.");
  }
  const expectedCollections = collections.slice().sort();
  const suppliedCollections = Object.keys(workspace).sort();
  if (suppliedCollections.length !== expectedCollections.length || suppliedCollections.some((name, index) => name !== expectedCollections[index])) {
    throw new Error("The backup must contain only clients, familyMembers, policies, and followUps.");
  }
  const result = {};
  for (const collectionName of collections) {
    if (!Array.isArray(workspace[collectionName])) throw new Error(`The ${collectionName} field must be an array.`);
    result[collectionName] = workspace[collectionName].map((record, index) => validateRecord(record, collectionName, index));
    const ids = result[collectionName].map((record) => record.id);
    if (new Set(ids).size !== ids.length) throw new Error(`The ${collectionName} collection contains duplicate IDs.`);
  }
  const clientIds = new Set(result.clients.map((client) => client.id));
  for (const collectionName of ["familyMembers", "policies", "followUps"]) {
    if (result[collectionName].some((record) => !clientIds.has(record.clientId))) {
      throw new Error(`Every record in ${collectionName} must reference an existing client.`);
    }
  }
  return result;
}

function readLocal(collectionName) {
  try {
    return JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${collectionName}`) || "[]");
  } catch (error) {
    console.error(`Unable to read ${collectionName} from local storage.`, error);
    return [];
  }
}

function writeLocal(collectionName, records) {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${collectionName}`, JSON.stringify(records));
  } catch (error) {
    throw new Error("Your changes could not be saved on this device. Check available storage and try again.");
  }
}

const localAdapter = {
  async list(collectionName) {
    return readLocal(collectionName);
  },
  async save(collectionName, record) {
    const records = readLocal(collectionName);
    const index = records.findIndex((item) => item.id === record.id);
    if (index === -1) records.push(record);
    else records[index] = record;
    writeLocal(collectionName, records);
    return record;
  },
  async remove(collectionName, id) {
    writeLocal(collectionName, readLocal(collectionName).filter((item) => item.id !== id));
  },
  async replaceWorkspace(workspace) {
    const validated = validateWorkspace(workspace);
    const previous = new Map(collections.map((name) => [name, localStorage.getItem(`${STORAGE_PREFIX}${name}`)]));
    try {
      for (const name of collections) localStorage.setItem(`${STORAGE_PREFIX}${name}`, JSON.stringify(validated[name]));
    } catch (error) {
      for (const name of collections) localStorage.removeItem(`${STORAGE_PREFIX}${name}`);
      let previousWorkspaceRestored = true;
      for (const [name, value] of previous) {
        if (value !== null) {
          try { localStorage.setItem(`${STORAGE_PREFIX}${name}`, value); }
          catch (restoreError) {
            previousWorkspaceRestored = false;
            console.error(`Unable to restore ${name} after an import error.`, restoreError);
          }
        }
      }
      if (previousWorkspaceRestored) throw new Error("The backup could not be restored on this device. Your previous workspace was kept.");
      throw new Error("The backup could not be restored, and this device could not fully recover the previous workspace. Check available storage before continuing.");
    }
  }
};

let activeAdapter = localAdapter;

export function configureDataAdapter(adapter) {
  if (!adapter || typeof adapter.list !== "function" || typeof adapter.save !== "function" || typeof adapter.remove !== "function" || typeof adapter.replaceWorkspace !== "function") {
    throw new Error("The data adapter must provide list, save, remove, and replaceWorkspace functions.");
  }
  activeAdapter = adapter;
}

export const db = {
  collections,
  list(collectionName) {
    return activeAdapter.list(collectionName);
  },
  save(collectionName, record) {
    return activeAdapter.save(collectionName, record);
  },
  remove(collectionName, id) {
    return activeAdapter.remove(collectionName, id);
  },
  replaceWorkspace(workspace) {
    return activeAdapter.replaceWorkspace(validateWorkspace(workspace));
  },
  async loadWorkspace() {
    const records = await Promise.all(collections.map((name) => activeAdapter.list(name)));
    return Object.fromEntries(collections.map((name, index) => [name, records[index]]));
  }
};
