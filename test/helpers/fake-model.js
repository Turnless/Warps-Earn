'use strict';
/**
 * Minimal in-memory stand-in for a Mongoose model.
 *
 * The routes under test only use a small slice of the Mongoose surface, so
 * rather than requiring a live MongoDB we implement exactly that slice:
 * findOne / findById / find / findOneAndUpdate / countDocuments / deleteOne /
 * updateOne, plus document save()/toObject()/set()/markModified().
 */

let idCounter = 0;
const nextId = () => `id_${++idCounter}`;

function getPath(obj, path) {
    return path.split('.').reduce((acc, k) => {
        if (acc == null) return acc;
        // Mongo semantics: "transactions.txId" collects the field from every
        // array element, and the caller then matches with "any of these".
        if (Array.isArray(acc) && !/^\d+$/.test(k)) {
            return acc.map(el => (el == null ? el : el[k])).filter(v => v !== undefined);
        }
        return acc[k];
    }, obj);
}

function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let cur = obj;
    for (const k of keys) {
        if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
        cur = cur[k];
    }
    cur[last] = value;
}

function matchValue(actual, expected) {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        for (const [op, val] of Object.entries(expected)) {
            switch (op) {
                case '$ne': if (String(actual) === String(val)) return false; break;
                case '$gt': if (!(actual > val)) return false; break;
                case '$gte': if (!(actual >= val)) return false; break;
                case '$lt': if (!(actual < val)) return false; break;
                case '$nin': if (val.some(v => String(v) === String(actual))) return false; break;
                case '$in': if (!val.some(v => String(v) === String(actual))) return false; break;
                case '$type': if (typeof actual !== val) return false; break;
                case '$elemMatch':
                    if (!Array.isArray(actual)) return false;
                    if (!actual.some(el => matches(el, val))) return false;
                    break;
                default: return false;
            }
        }
        return true;
    }
    if (Array.isArray(actual)) return actual.some(a => String(a) === String(expected));
    return String(actual) === String(expected);
}

function matches(doc, query) {
    for (const [key, expected] of Object.entries(query || {})) {
        if (key === '$or') {
            if (!expected.some(sub => matches(doc, sub))) return false;
            continue;
        }
        if (!matchValue(getPath(doc, key), expected)) return false;
    }
    return true;
}

function deepClone(v) {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/**
 * @param {string} name        model name (for error messages)
 * @param {string[]} required  field names that must be present on save()
 * @param {object} requiredSubdocs  {arrayField: [required keys]} — mirrors the
 *        required fields on embedded Mongoose subdocument schemas, which are
 *        validated on save() just like top-level paths.
 */
function createModel(name, required = [], requiredSubdocs = {}) {
    const store = new Map();

    function makeDoc(data) {
        const doc = Object.assign({}, deepClone(data));
        if (!doc._id) doc._id = nextId();

        Object.defineProperties(doc, {
            save: {
                value: async function () {
                    // Lets a test simulate a write failing mid-transaction.
                    // Routes capture the model at require time, so the switch
                    // has to live on the model rather than the module binding.
                    if (Model.__failSave) {
                        const err = new Error(Model.__failSaveMessage || `${name} write failed`);
                        err.name = Model.__failSaveName || 'MongoNetworkError';
                        throw err;
                    }
                    for (const field of required) {
                        const v = getPath(this, field);
                        if (v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))) {
                            const err = new Error(`${name} validation failed: ${field}: Path \`${field}\` is required.`);
                            err.name = 'ValidationError';
                            throw err;
                        }
                    }
                    for (const [arrField, keys] of Object.entries(requiredSubdocs)) {
                        const arr = this[arrField];
                        if (!Array.isArray(arr)) continue;
                        arr.forEach((el, i) => {
                            for (const k of keys) {
                                const v = el == null ? undefined : el[k];
                                if (v === undefined || v === null || (typeof v === 'number' && Number.isNaN(v))) {
                                    const err = new Error(
                                        `${name} validation failed: ${arrField}.${i}.${k}: Path \`${k}\` is required.`
                                    );
                                    err.name = 'ValidationError';
                                    throw err;
                                }
                            }
                        });
                    }
                    store.set(String(this._id), deepClone(stripMethods(this)));
                    return this;
                }
            },
            toObject: { value: function () { return deepClone(stripMethods(this)); } },
            set: { value: function (path, value) { setPath(this, path, value); } },
            markModified: { value: function () {} },
            __isDoc: { value: true }
        });
        return doc;
    }

    function stripMethods(doc) {
        const out = {};
        for (const k of Object.keys(doc)) out[k] = doc[k];
        return out;
    }

    function hydrate(raw) { return raw ? makeDoc(raw) : null; }

    // find() returns a thenable that also supports .sort().limit().lean().
    // `mapper` shapes the resolved rows (single doc for findOne, array for find).
    function makeQuery(resolver, mapper = (rows) => rows) {
        const q = {
            sort() { return q; },
            limit(n) { q._limit = n; return q; },
            lean() { q._lean = true; return q; },
            then(onOk, onErr) {
                return Promise.resolve()
                    .then(() => {
                        let rows = resolver();
                        if (q._limit) rows = rows.slice(0, q._limit);
                        return mapper(rows, q);
                    })
                    .then(onOk, onErr);
            }
        };
        return q;
    }

    const Model = function (data) { return makeDoc(data); };

    Model.__store = store;
    Model.__failSave = false;
    Model.__failSaveMessage = null;
    Model.__failSaveName = null;
    Model.__seed = (docs) => {
        for (const d of [].concat(docs)) {
            const doc = makeDoc(d);
            store.set(String(doc._id), deepClone(stripMethods(doc)));
        }
    };
    Model.__all = () => Array.from(store.values());
    Model.__clear = () => store.clear();

    Model.findOne = function (query = {}) {
        return makeQuery(
            () => Array.from(store.values()).filter(d => matches(d, query)),
            (rows, q) => (q._lean ? (deepClone(rows[0]) || null) : hydrate(rows[0]))
        );
    };

    Model.findById = function (id) {
        return Model.findOne({ _id: id });
    };

    Model.find = function (query = {}) {
        return makeQuery(() => Array.from(store.values()).filter(d => matches(d, query)).map(deepClone));
    };

    Model.countDocuments = async function (query = {}) {
        return Array.from(store.values()).filter(d => matches(d, query)).length;
    };

    Model.deleteOne = async function (query) {
        for (const [k, v] of store) if (matches(v, query)) { store.delete(k); return { deletedCount: 1 }; }
        return { deletedCount: 0 };
    };

    Model.updateOne = async function (query, update) {
        for (const [k, v] of store) {
            if (matches(v, query)) {
                const $set = update.$set || update;
                for (const [field, val] of Object.entries($set)) {
                    if (field.startsWith('$')) continue;
                    setPath(v, field, val);
                }
                store.set(k, v);
                return { modifiedCount: 1 };
            }
        }
        return { modifiedCount: 0 };
    };

    Model.findOneAndUpdate = async function (query, update) {
        for (const [k, v] of store) {
            if (!matches(v, query)) continue;
            if (update.$set) {
                for (const [field, val] of Object.entries(update.$set)) {
                    // support the positional operator used for referrals.$
                    if (field.includes('.$.')) {
                        const [arrName, , prop] = field.split('.');
                        const elemMatch = query[`${arrName}.telegram_id`];
                        const target = (v[arrName] || []).find(e => String(e.telegram_id) === String(elemMatch));
                        if (target) target[prop] = val;
                    } else {
                        setPath(v, field, val);
                    }
                }
            }
            if (update.$inc) {
                for (const [field, val] of Object.entries(update.$inc)) {
                    setPath(v, field, (getPath(v, field) || 0) + val);
                }
            }
            if (update.$pull) {
                for (const [field, criteria] of Object.entries(update.$pull)) {
                    const arr = getPath(v, field);
                    if (!Array.isArray(arr)) continue;
                    setPath(v, field, arr.filter(el => !matches(el, criteria)));
                }
            }
            if (update.$push) {
                for (const [field, spec] of Object.entries(update.$push)) {
                    const arr = getPath(v, field) || [];
                    const items = spec.$each || [spec];
                    if (spec.$position === 0) arr.unshift(...items); else arr.push(...items);
                    setPath(v, field, arr);
                }
            }
            store.set(k, v);
            return hydrate(v);
        }
        return null;
    };

    Model.aggregate = async function () { return []; };

    return Model;
}

module.exports = { createModel, matches };
