'use strict'

const EARTH_M = 6371000

function haversineM (a, b) {
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

function positionLatLon (position) {
  if (!position || typeof position !== 'object') return null
  const lat = Number(position.latitude != null ? position.latitude : position.lat)
  const lon = Number(position.longitude != null ? position.longitude : position.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { lat, lon }
}

function zoneDistanceM (position, zone) {
  const pos = positionLatLon(position)
  if (!pos || !zone) return null
  return haversineM(pos, { lat: Number(zone.lat), lon: Number(zone.lon) })
}

function inZone (position, zone) {
  const d = zoneDistanceM(position, zone)
  if (d == null || !zone) return false
  return d <= Number(zone.radius)
}

function toRad (deg) {
  return (Number(deg) * Math.PI) / 180
}

module.exports = { haversineM, inZone, positionLatLon, zoneDistanceM }
