import { createSearchTask } from '../../../resources/js/search/task.ts'
import { openSearchStorage } from '../../../resources/js/search/storage.ts'
import { createSearchPersistence } from '../../../resources/js/search/persistence.ts'
window.storageHarness = { createSearchTask, openSearchStorage, createSearchPersistence }
