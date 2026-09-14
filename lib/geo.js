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

function inZone (position, zone) {
  if (!position || !zone) return false
  if (!Number.isFinite(position.latitude) || !Number.isFinite(position.longitude)) {
    return false
  }
  const d = haversineM(
    { lat: position.latitude, lon: position.longitude },
    { lat: zone.lat, lon: zone.lon }
  )
  return d <= Number(zone.radius)
}

function toRad (deg) {
  return (Number(deg) * Math.PI) / 180
}

module.exports = { haversineM, inZone }
