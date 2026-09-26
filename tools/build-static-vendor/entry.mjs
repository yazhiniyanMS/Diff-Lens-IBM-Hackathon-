import "./shim.js";
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import LightningFS from "@isomorphic-git/lightning-fs";

window.DiffLensGitVendor = { git, http, LightningFS };
