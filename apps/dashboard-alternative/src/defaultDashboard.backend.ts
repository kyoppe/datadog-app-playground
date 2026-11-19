import { getDatastoreItem, putDatastoreItem } from '@datadog/action-catalog/dd/apps_datastore';

// Where the default dashboard is kept: one row in a Datadog datastore.
//
// One-time setup: in Datadog open Datastores, click "+ New Datastore", set the primary key
// column to `key` (a string), create it, then copy its ID (Table Options) into DATASTORE_ID.
// Until then the app falls back to the default compiled into the frontend.
const DATASTORE_ID = 'ea2cdcc7-b970-4467-823d-150a493e1428';
const ITEM_KEY = 'default-dashboard';
const DASHBOARD_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export type DefaultDashboard = {
    /** False until DATASTORE_ID is filled in. */
    configured: boolean;
    /** The saved dashboard ID, or null if none has been saved yet. */
    id: string | null;
};

export async function getDefaultDashboardId(): Promise<DefaultDashboard> {
    if (!DATASTORE_ID) {
        return { configured: false, id: null };
    }

    try {
        const response = await getDatastoreItem({
            inputs: { datastoreId: DATASTORE_ID, key: ITEM_KEY },
        });
        const id: unknown = response.item?.dashboardId;
        return {
            configured: true,
            id: typeof id === 'string' && DASHBOARD_ID_PATTERN.test(id) ? id : null,
        };
    } catch {
        // No row yet is the normal first-run case.
        return { configured: true, id: null };
    }
}

export async function setDefaultDashboardId(dashboardId: string): Promise<void> {
    if (!DATASTORE_ID) {
        throw new Error('No datastore is configured for the default dashboard.');
    }
    if (!DASHBOARD_ID_PATTERN.test(dashboardId)) {
        throw new Error('That does not look like a dashboard ID.');
    }

    await putDatastoreItem({
        inputs: {
            datastoreId: DATASTORE_ID,
            item: { key: ITEM_KEY, dashboardId },
            overwrite: true,
        },
    });
}
