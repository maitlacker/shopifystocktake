/**
 * Asana API client — read-only, Personal Access Token auth
 * Used for pulling production order data from the "Orders - Production" project
 */
const fetch = require('node-fetch');

const BASE = 'https://app.asana.com/api/1.0';

function headers() {
  return {
    Authorization: `Bearer ${process.env.ASANA_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function asanaGet(path, params) {
  const url = new URL(`${BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v != null) url.searchParams.set(k, v);
    });
  }

  const res = await fetch(url.toString(), { headers: headers() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Asana ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  return json.data;
}

// Paginate through all results for a given path
async function asanaGetAll(path, params) {
  const results = [];
  let offset = null;

  while (true) {
    const url = new URL(`${BASE}${path}`);
    const p   = { limit: 100, ...params };
    if (offset) p.offset = offset;
    Object.entries(p).forEach(([k, v]) => {
      if (v != null) url.searchParams.set(k, v);
    });

    const res  = await fetch(url.toString(), { headers: headers() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Asana ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    results.push(...(json.data || []));

    if (json.next_page?.offset) {
      offset = json.next_page.offset;
    } else {
      break;
    }
  }

  return results;
}

// Verify token + return current user + workspaces
async function getMe() {
  return asanaGet('/users/me', { opt_fields: 'name,email,workspaces.name,workspaces.gid' });
}

// List all projects in a workspace
async function getProjects(workspaceGid) {
  return asanaGetAll('/projects', {
    workspace:  workspaceGid,
    opt_fields: 'name,gid,created_at,modified_at,archived,color,notes',
    archived:   false,
  });
}

// Get full task list for a project, including all custom fields
async function getProjectTasks(projectGid) {
  // First get the project's custom field settings so we know all field definitions
  const customFieldSettings = await asanaGetAll(`/projects/${projectGid}/custom_field_settings`, {
    opt_fields: 'custom_field.name,custom_field.gid,custom_field.type,custom_field.enum_options',
  }).catch(() => []);

  // Then get tasks with expanded fields
  const tasks = await asanaGetAll('/tasks', {
    project:    projectGid,
    opt_fields: [
      'name',
      'gid',
      'created_at',
      'modified_at',
      'completed',
      'completed_at',
      'due_on',
      'start_on',
      'assignee.name',
      'assignee.email',
      'notes',
      'num_subtasks',
      'tags.name',
      'memberships.section.name',
      'custom_fields.name',
      'custom_fields.gid',
      'custom_fields.type',
      'custom_fields.text_value',
      'custom_fields.number_value',
      'custom_fields.enum_value.name',
      'custom_fields.date_value',
      'custom_fields.display_value',
    ].join(','),
  });

  return { tasks, customFieldSettings };
}

// Get subtasks of a task
async function getSubtasks(taskGid) {
  return asanaGetAll(`/tasks/${taskGid}/subtasks`, {
    opt_fields: [
      'name', 'gid', 'completed', 'due_on', 'notes', 'assignee.name',
      'custom_fields.name', 'custom_fields.display_value',
      'custom_fields.text_value', 'custom_fields.number_value',
      'custom_fields.enum_value.name',
    ].join(','),
  });
}

module.exports = { getMe, getProjects, getProjectTasks, getSubtasks };
