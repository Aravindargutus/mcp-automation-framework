#!/usr/bin/env node
/**
 * Weather MCP Server — provides weather-related tools for testing.
 *
 * Tools:
 *   get_current_weather  — Returns current weather for a given city
 *   get_forecast         — Returns a 5-day weather forecast
 *   get_weather_alerts   — Returns active weather alerts for a region
 *
 * Resources:
 *   weather://popular-cities  — List of popular city names with coordinates
 *
 * Accepts ANY city name — well-known cities use realistic coordinates,
 * unknown cities get deterministic simulated data derived from the name.
 * No external API key required, making it perfect for testing.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ─── Simulated weather data ─────────────────────────────────────────

const CITIES = {
  'new york': { lat: 40.71, lon: -74.01, tz: 'America/New_York' },
  'london':   { lat: 51.51, lon: -0.13, tz: 'Europe/London' },
  'tokyo':    { lat: 35.68, lon: 139.69, tz: 'Asia/Tokyo' },
  'paris':    { lat: 48.86, lon: 2.35, tz: 'Europe/Paris' },
  'sydney':   { lat: -33.87, lon: 151.21, tz: 'Australia/Sydney' },
  'mumbai':   { lat: 19.08, lon: 72.88, tz: 'Asia/Kolkata' },
  'cairo':    { lat: 30.04, lon: 31.24, tz: 'Africa/Cairo' },
  'são paulo':{ lat: -23.55, lon: -46.63, tz: 'America/Sao_Paulo' },
  'berlin':   { lat: 52.52, lon: 13.41, tz: 'Europe/Berlin' },
  'toronto':  { lat: 43.65, lon: -79.38, tz: 'America/Toronto' },
};

const CONDITIONS = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Light Rain', 'Heavy Rain', 'Thunderstorm', 'Snow', 'Foggy', 'Windy', 'Clear'];
const ALERT_TYPES = ['Heat Advisory', 'Winter Storm Warning', 'Flood Watch', 'Tornado Watch', 'High Wind Warning', 'Dense Fog Advisory'];

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xFFFFFFFF;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

/**
 * Hash a string to a numeric seed for deterministic random generation.
 * Allows any city name to produce consistent simulated weather.
 */
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xFFFFFFFF;
  }
  return hash >>> 0;
}

/**
 * Resolve city info — returns known data for popular cities,
 * or generates plausible coordinates for any unknown city.
 */
function resolveCityInfo(city) {
  const key = city.toLowerCase();
  if (CITIES[key]) return CITIES[key];

  // Generate deterministic but plausible coordinates from the city name
  const h = hashString(key);
  const rng = seededRandom(h);
  const lat = (rng() * 140 - 70);   // -70 to +70 latitude
  const lon = (rng() * 360 - 180);  // -180 to +180 longitude
  const TIMEZONES = ['America/New_York', 'Europe/London', 'Asia/Tokyo', 'America/Los_Angeles',
    'Europe/Berlin', 'Asia/Shanghai', 'Australia/Sydney', 'America/Chicago',
    'Asia/Kolkata', 'Africa/Cairo', 'America/Sao_Paulo', 'Pacific/Auckland'];
  const tz = TIMEZONES[Math.floor(rng() * TIMEZONES.length)];
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, tz };
}

function generateWeather(city, dayOffset = 0) {
  const key = city.toLowerCase();
  const info = resolveCityInfo(city);

  const dateSeed = new Date();
  dateSeed.setDate(dateSeed.getDate() + dayOffset);
  const seed = (info.lat * 1000 + info.lon * 1000 + dateSeed.getDate() * 100 + dateSeed.getMonth() * 10) | 0;
  const rng = seededRandom(seed);

  // Base temp varies by latitude (tropical vs polar)
  const baseTemp = 25 - Math.abs(info.lat) * 0.4 + (dayOffset * 0.5);
  const tempC = Math.round((baseTemp + (rng() * 10 - 5)) * 10) / 10;
  const tempF = Math.round((tempC * 9/5 + 32) * 10) / 10;
  const humidity = Math.round(40 + rng() * 50);
  const windSpeed = Math.round(rng() * 30 * 10) / 10;
  const condition = CONDITIONS[Math.floor(rng() * CONDITIONS.length)];
  const pressure = Math.round(1000 + rng() * 30);
  const uvIndex = Math.round(rng() * 11);
  const visibility = Math.round((5 + rng() * 15) * 10) / 10;

  return {
    city: key.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
    coordinates: { latitude: info.lat, longitude: info.lon },
    timezone: info.tz,
    temperature: { celsius: tempC, fahrenheit: tempF },
    condition,
    humidity_percent: humidity,
    wind: { speed_kmh: windSpeed, direction: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.floor(rng() * 8)] },
    pressure_hpa: pressure,
    uv_index: uvIndex,
    visibility_km: visibility,
    date: dateSeed.toISOString().split('T')[0],
  };
}

function generateAlerts(region) {
  const seed = region.length * 31 + new Date().getDate();
  const rng = seededRandom(seed);
  const count = Math.floor(rng() * 3); // 0-2 alerts
  const alerts = [];

  for (let i = 0; i < count; i++) {
    const alertType = ALERT_TYPES[Math.floor(rng() * ALERT_TYPES.length)];
    const severity = ['Minor', 'Moderate', 'Severe', 'Extreme'][Math.floor(rng() * 4)];
    const start = new Date();
    start.setHours(start.getHours() + Math.floor(rng() * 12));
    const end = new Date(start);
    end.setHours(end.getHours() + Math.floor(6 + rng() * 48));

    alerts.push({
      type: alertType,
      severity,
      region,
      headline: `${severity} ${alertType} for ${region}`,
      description: `A ${severity.toLowerCase()} ${alertType.toLowerCase()} is in effect for ${region}. Take appropriate precautions.`,
      effective: start.toISOString(),
      expires: end.toISOString(),
    });
  }

  return alerts;
}

// ─── MCP Server setup ──────────────────────────────────────────────

const server = new McpServer(
  { name: 'weather-server', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
    instructions: 'A weather information server providing current conditions, forecasts, and alerts for any city worldwide. Use get_current_weather for current conditions, get_forecast for multi-day forecasts, and get_weather_alerts for active weather alerts. All city names are accepted.',
  },
);

// ─── Tools ──────────────────────────────────────────────────────────

server.tool(
  'get_current_weather',
  'Get the current weather conditions for any city worldwide. Returns temperature, humidity, wind, and other atmospheric data. Uses simulated data for demonstration.',
  {
    city: z.string().describe('Any city name (e.g., "New York", "London", "San Francisco", "Tokyo")'),
    units: z.enum(['metric', 'imperial']).optional().default('metric').describe('Temperature units: "metric" (Celsius) or "imperial" (Fahrenheit)'),
  },
  async ({ city, units }) => {
    const weather = generateWeather(city);

    const temp = units === 'imperial'
      ? `${weather.temperature.fahrenheit}°F`
      : `${weather.temperature.celsius}°C`;

    const summary = [
      `Weather for ${weather.city} (${weather.date})`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      `Condition:   ${weather.condition}`,
      `Temperature: ${temp}`,
      `Humidity:    ${weather.humidity_percent}%`,
      `Wind:        ${weather.wind.speed_kmh} km/h ${weather.wind.direction}`,
      `Pressure:    ${weather.pressure_hpa} hPa`,
      `UV Index:    ${weather.uv_index}`,
      `Visibility:  ${weather.visibility_km} km`,
    ].join('\n');

    return {
      content: [{ type: 'text', text: summary }],
      structuredContent: weather,
    };
  },
);

server.tool(
  'get_forecast',
  'Get a multi-day weather forecast for any city worldwide. Returns daily high/low temperatures and conditions. Uses simulated data for demonstration.',
  {
    city: z.string().describe('Any city name (e.g., "New York", "London", "San Francisco", "Tokyo")'),
    days: z.number().int().min(1).max(7).optional().default(5).describe('Number of forecast days (1-7, default 5)'),
  },
  async ({ city, days }) => {
    const forecast = [];
    for (let i = 0; i < days; i++) {
      const day = generateWeather(city, i);
      const highC = Math.round((day.temperature.celsius + 3) * 10) / 10;
      const lowC = Math.round((day.temperature.celsius - 4) * 10) / 10;
      forecast.push({
        date: day.date,
        condition: day.condition,
        high: { celsius: highC, fahrenheit: Math.round((highC * 9/5 + 32) * 10) / 10 },
        low: { celsius: lowC, fahrenheit: Math.round((lowC * 9/5 + 32) * 10) / 10 },
        humidity_percent: day.humidity_percent,
        wind_kmh: day.wind.speed_kmh,
      });
    }

    const lines = [`${days}-Day Forecast for ${city.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')}`, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'];
    for (const day of forecast) {
      lines.push(`${day.date}  ${day.condition.padEnd(16)} High: ${day.high.celsius}°C  Low: ${day.low.celsius}°C  Humidity: ${day.humidity_percent}%`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { city: city.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '), forecast },
    };
  },
);

server.tool(
  'get_weather_alerts',
  'Get active weather alerts for a specified region. Returns alert type, severity, and duration.',
  {
    region: z.string().describe('Region or city name to check for alerts'),
  },
  async ({ region }) => {
    const alerts = generateAlerts(region);

    if (alerts.length === 0) {
      return {
        content: [{ type: 'text', text: `No active weather alerts for "${region}".` }],
        structuredContent: { region, alerts: [] },
      };
    }

    const lines = [`Active Weather Alerts for ${region}`, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━'];
    for (const alert of alerts) {
      lines.push(`⚠ ${alert.type} (${alert.severity})`);
      lines.push(`  ${alert.headline}`);
      lines.push(`  Effective: ${alert.effective}`);
      lines.push(`  Expires:   ${alert.expires}`);
      lines.push('');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: { region, alerts },
    };
  },
);

// ─── Resources ──────────────────────────────────────────────────────

server.resource(
  'popular-cities',
  'weather://popular-cities',
  { description: 'List of popular cities with known coordinates. Any city name is accepted by the tools — this is just a reference list.', mimeType: 'application/json' },
  async () => ({
    contents: [{
      uri: 'weather://popular-cities',
      mimeType: 'application/json',
      text: JSON.stringify(
        Object.entries(CITIES).map(([name, info]) => ({
          name: name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
          ...info,
        })),
        null,
        2,
      ),
    }],
  }),
);

// ─── Start ──────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
