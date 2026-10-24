// Existing browser modules remain external so collection, account and watch
// controllers use the same language, storage and event stream during migration.
declare module "/web/js/lib/*";
declare module "/web/js/pages/*";
declare module "/web/collect/*";
