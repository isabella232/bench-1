'use strict'

// TODO: move to package (shared with subleveldown, level-test)
module.exports = function (db, type, visit) {
  if (typeof type === 'function') {
    visit = type
    type = null
  }

  return reachdown(db, type, visit)
}

function reachdown (db, type, visit) {
  if (typeof db.down === 'function') return db.down(type, visit)
  if (type && db.type === type) return db
  if (visit && visit(db)) return db
  if (isLooseAbstract(db.db)) return reachdown(db.db, type, visit)
  if (isLooseAbstract(db._db)) return reachdown(db._db, type, visit)
  return type || visit ? null : db
}

function isLooseAbstract (db) {
  if (!db || typeof db !== 'object') return false
  return typeof db.status === 'string' && typeof db._iterator === 'function'
}
