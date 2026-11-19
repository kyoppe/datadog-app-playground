import { listDashboards } from '@datadog/action-catalog/dd/dashboard';

export type DashboardOption = {
    id: string;
    title: string;
    /** Path on the Datadog site, e.g. /dashboard/abc-def-ghi/my-dashboard. */
    url: string;
};

const MAX_DASHBOARDS = 500;

// The dashboards of the caller's organization, for the selector.
export async function listOrgDashboards(): Promise<DashboardOption[]> {
    const response = await listDashboards({ inputs: {} });

    return (response.dashboards ?? [])
        .flatMap((dashboard) =>
            dashboard.id
                ? [
                      {
                          id: dashboard.id,
                          title: dashboard.title?.trim() || dashboard.id,
                          url: dashboard.url || `/dashboard/${dashboard.id}`,
                      },
                  ]
                : [],
        )
        .sort((a, b) => a.title.localeCompare(b.title))
        .slice(0, MAX_DASHBOARDS);
}
