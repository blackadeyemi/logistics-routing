// Helpers for GEOGRAPHY(POINT, 4326) columns. Locations travel through the
// API as { lat, lng } or null.

// SQL that builds a point from two parameters, lng first. ST_MakePoint is
// strict, so a null parameter gives a null location.
function pointSql(lngParam, latParam) {
  return `ST_SetSRID(ST_MakePoint(${lngParam}::float8, ${latParam}::float8), 4326)::geography`;
}

// SQL select fragment returning <alias>_lat and <alias>_lng.
function latLngSql(column, alias) {
  return `ST_Y(${column}::geometry) AS ${alias}_lat, ST_X(${column}::geometry) AS ${alias}_lng`;
}

function toLocation(lat, lng) {
  return lat === null || lat === undefined ? null : { lat, lng };
}

function lngLat(loc) {
  return loc ? [loc.lng, loc.lat] : [null, null];
}

module.exports = { pointSql, latLngSql, toLocation, lngLat };
