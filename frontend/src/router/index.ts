import { createRouter, createWebHistory } from 'vue-router'

import Overview from '@/views/Overview.vue'
const Queryeditor = () => import('@/views/queryeditor/index.vue')
const Datasources = () => import('@/views/datasources/index.vue')
const Queryhistory = () => import('@/views/queryhistory/index.vue')
const Chartbuilder = () => import('@/views/chartbuilder/index.vue')
const Dashboardboard = () => import('@/views/dashboardboard/index.vue')
const Exporttask = () => import('@/views/exporttask/index.vue')
const Analysisnote = () => import('@/views/analysisnote/index.vue')
const Paramquery = () => import('@/views/paramquery/index.vue')
const Schedulerjob = () => import('@/views/schedulerjob/index.vue')
const Dataschema = () => import('@/views/dataschema/index.vue')
const Queryopt = () => import('@/views/queryopt/index.vue')
const Pivotable = () => import('@/views/pivotable/index.vue')
const PivotWorkbench = () => import('@/views/pivotable/workbench.vue')
const Datacompare = () => import('@/views/datacompare/index.vue')
const Permission = () => import('@/views/permission/index.vue')
const Taggroup = () => import('@/views/taggroup/index.vue')
const Resulteval = () => import('@/views/resulteval/index.vue')
const Sharelink = () => import('@/views/sharelink/index.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'overview', component: Overview },
    { path: '/queryeditor', name: 'queryeditor', component: Queryeditor },
    { path: '/datasources', name: 'datasources', component: Datasources },
    { path: '/queryhistory', name: 'queryhistory', component: Queryhistory },
    { path: '/chartbuilder', name: 'chartbuilder', component: Chartbuilder },
    { path: '/dashboardboard', name: 'dashboardboard', component: Dashboardboard },
    { path: '/exporttask', name: 'exporttask', component: Exporttask },
    { path: '/analysisnote', name: 'analysisnote', component: Analysisnote },
    { path: '/paramquery', name: 'paramquery', component: Paramquery },
    { path: '/schedulerjob', name: 'schedulerjob', component: Schedulerjob },
    { path: '/dataschema', name: 'dataschema', component: Dataschema },
    { path: '/queryopt', name: 'queryopt', component: Queryopt },
    { path: '/pivotable', name: 'pivotable', component: Pivotable },
    { path: '/pivotable/workbench', name: 'pivot-workbench', component: PivotWorkbench },
    { path: '/datacompare', name: 'datacompare', component: Datacompare },
    { path: '/permission', name: 'permission', component: Permission },
    { path: '/taggroup', name: 'taggroup', component: Taggroup },
    { path: '/resulteval', name: 'resulteval', component: Resulteval },
    { path: '/sharelink', name: 'sharelink', component: Sharelink },
  ],
})

export default router
