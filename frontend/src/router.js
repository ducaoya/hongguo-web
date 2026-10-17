import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/', component: () => import('./views/HomeView.vue') },
  { path: '/feed', component: () => import('./views/FeedView.vue') },
  { path: '/category/:type?/:sub?/:page?', component: () => import('./views/CategoryView.vue') },
  { path: '/rank/:route/:page?', component: () => import('./views/RankView.vue') },
  { path: '/history', component: () => import('./views/HistoryView.vue') },
  { path: '/search/:q', component: () => import('./views/SearchView.vue') },
  { path: '/series/:id', component: () => import('./views/SeriesView.vue') },
  { path: '/play/:sid/:vid', component: () => import('./views/PlayerView.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export default createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior() { return { left: 0, top: 0 } },
})
