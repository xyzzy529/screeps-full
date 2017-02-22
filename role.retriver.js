// Copyright © 2017 Douglas P. Fields, Jr. All Rights Reserved.
// Web: https://symbolics.lisp.engineer/
// E-mail: symbolics@lisp.engineer
// Twitter: @LispEngineer

// Remote retriever. Gets resources from remote rooms and brings them back.

// Memory:
// target_room = the room we're harvesting from
// return_room = the room we return our resources to
// needs_return_room = True until we have set our return_room, which we can only do once
//                     we are in our target_room.
// initialized

"use strict";
const util = require('util');
const c = require('creep');
const resources = require('resources');
const upgrader = require('role.upgrader');
const harvester = require('role.harvester');
const emoji = require('emoji');
const flag = require('flag');

const THIS_ROLE = 'retriver'; // SIC

/** How many remote harvesters we have per source in a remote room. */
const NUM_DESIRED_PER_FLAG = 1;

/** Color of remote harvesting flags */
const REMOTE_RETRIEVE_FLAG_COLOR = COLOR_YELLOW;
const REMOTE_RETRIEVE_FLAG_SEC_COLOR = COLOR_BLUE;

/** We store a long-term-viewed cache in here for the times when we
 * lose visibility into a room. */
global.remote_harvest_cache = {};

// Looks for flags which tell me which rooms we should be harvesting.
function get_rooms_to_harvest() {
    
    if (global.volatile.get_rooms_to_harvest != null) {
        return global.volatile.get_rooms_to_retrieve;
    }
    
    const remote_harvest_flags = _.filter(Game.flags, f => f.color == REMOTE_RETRIEVE_FLAG_COLOR &&
                                                           f.secondaryColor == REMOTE_RETRIEVE_FLAG_SEC_COLOR);
    // f.room may be undefined if we have no visibility into the room                                                       
    const remote_harvest_rooms = remote_harvest_flags.map(f => f.pos.roomName);
    const bad_rooms = [];
    
    // Double check flags and remove ones where we control it or someone else does
    for (const rhr of remote_harvest_rooms) {
        const room = Game.rooms[rhr];
        
        if (room == null) {
            // We have no visibility into the room; assume one source and hence only
            // send one remote harvester into there.
            continue;
        }
        if (room.controller == null) {
            // There's no controller, so we can do whatever we want
            continue;
        }
        
        if (room.controller.my) {
            // We already own this room, so we shouldn't have it flagged for remote harvesting, should we?
            // Sure - as we may not have built it up yet.
            continue;
        }
    }
    
    _.remove(remote_harvest_rooms, rhr => bad_rooms.includes(rhr));
    
    // console.log('Remote harvesting rooms per flag:', JSON.stringify(remote_harvest_rooms),
    //                                                  JSON.stringify(remote_harvest_rooms.map(get_harvesters_needed)));
    
    // cache result for later                                                 
    global.volatile.get_rooms_to_retrieve = remote_harvest_rooms;
    return remote_harvest_rooms;
} // get_rooms_to_harvest

// Gets the number of harvesters needed for the specified room.
// We cache this in global.volatile so we calculate it only once
// per tick. Additionally, we cache it in global-non-volatile so
// if we lose visibility into a room, we can remember the last thing
// we saw.
function get_harvesters_needed(room_name) {
    if (global.volatile.get_retrieves_needed == null) {
        global.volatile.get_retrieves_needed = {};
    }
    if (global.volatile.get_retrieves_needed[room_name] != null) {
        return global.volatile.get_retrieves_needed[room_name];
    }
    
    const remote_harvest_flags = _.filter(Game.flags, f => f.color == REMOTE_RETRIEVE_FLAG_COLOR &&
                                                           f.secondaryColor == REMOTE_RETRIEVE_FLAG_SEC_COLOR);
    let retval = 0;
    
    if (_.any(remote_harvest_flags, f => f.pos.roomName == room_name)) {
        retval = NUM_DESIRED_PER_FLAG;
    }                                                           

    global.volatile.get_retrieves_needed[room_name] = retval;
    return retval;
} // get_harvesters_needed



// Get as big a body as we can
function spawn_body(room) {
    const ri = resources.summarize_room(room);

    const group = [CARRY, CARRY, MOVE];
    const groupPrice = 150;
    const maxGroups = 16;
    const numGroups = Math.min(maxGroups, Math.floor(ri.energy_cap / groupPrice));
    let retval = [];

    for (let i = 0; i < numGroups; i++) {
        retval = retval.concat(group);
    }

    return retval;
} // spawn_body

function num_desired(room_ignored) {
    if (global.volatile.retrieve_num_desired != null) {
        return global.volatile.retrieve_num_desired;
    }
    const rth = get_rooms_to_harvest();
    const retval = _.sum(rth.map(get_harvesters_needed));
    // console.log('Remote harvesters needed:', retval);
    global.volatile.retrieve_num_desired = retval;
    return retval;
} // num_desired

// Harvest energy from our highest level room.
function harvest(creep) {
    if (creep.room.name == creep.memory.target_room) {
        // console.log(creep.name + ' in source room, harvesting');
        c.reload_energy(creep, [STRUCTURE_CONTAINER, STRUCTURE_STORAGE, STRUCTURE_LINK,
                                STRUCTURE_SPAWN, STRUCTURE_EXTENSION,
                                STRUCTURE_TOWER, STRUCTURE_TERMINAL]) ||
            c.load_resource(creep, [STRUCTURE_STORAGE, STRUCTURE_CONTAINER, STRUCTURE_TERMINAL]);
        // TODO: load_resources                        
    } else {
        // console.log(creep.name + ' moving to source room');
        c.move_to_room_safe(creep, creep.memory.target_room);
    }
}

function deliver(creep) {
    if (creep.room.name == creep.memory.return_room) {
        // console.log(creep.name + ' in deposit room, depositing');
        c.deliver_storage_energy(creep, [STRUCTURE_STORAGE]) ||
            c.deliver_storage_energy(creep, [STRUCTURE_CONTAINER]) ||
            c.deliver_structure(creep, [STRUCTURE_EXTENSION, STRUCTURE_SPAWN, STRUCTURE_TOWER], RESOURCE_ENERGY);
    } else {
        // console.log(creep.name + ' moving to delivery room');
        if (creep.memory.return_room == null) {
            // Figure out how and why this ever happens...
            console.log('[ERROR] Null return room?');
            setup_return_room(creep);
            console.log('[ERROR recovery] Return room now: ' + creep.memory.return_room);
        }
        c.move_to_room_safe(creep, creep.memory.return_room);
    }
}

/** Initializes the creep's memory. For now, we'll just wing it. */
function initialize(creep) {
    if (creep.memory.initialized) {
        // console.log(creep.name, 'memory already initialized');
        return;
    }
    
    // Determine which room this creep should go to.
    // 1. Enumerate all the rooms
    // 2. Enumerate all the creeps desired for each room
    // 3. Enumerate the number of creeps assigned to each room
    // 4. If any are under-assigned, assign to that room
    // 5. If all are assigned, find shortest-time-to-live creep and assign to that room

    let desired_room = flag.assign_room(get_rooms_to_harvest(), get_harvesters_needed,
                                        THIS_ROLE, 'target_room');

    // Shouldn't happen?
    if (desired_room == null) {
        console.log(creep.name, 'cannot be initialized due to no remote retrieving room located');
        desired_room = creep.memory.birth_room;
    }

    creep.memory.target_room = desired_room;
    creep.memory.return_room = creep.memory_birth_room;
    // FIXME: CODE CLOSEST STORAGE ROOM TO REMOTE HARVEST
    creep.memory.needs_return_room = true;
    creep.memory.multi_room = true; // Really should just set this once at spawn time
    creep.memory.initialized = true;
    // console.log(creep.name, 'initialized memory');
} // initialize

// Now that we're in our target room, let's find the closest path to
// a room in which we can drop off our energy.
function setup_return_room(creep) {
    let closest_room = util.find_closest_room(creep.room, FIND_SOURCES, [STRUCTURE_STORAGE]);

    if (closest_room == '') {
        // Didn't find any storages
        closest_room = util.find_closest_room(creep.room, FIND_SOURCES, [STRUCTURE_SPAWN]);
    }
    if (closest_room == null || closest_room == '') {
        // Should never happen
        console.log(creep.name, '[ERROR] should never happen, in', creep.pos);
        return;
    }

    console.log(creep.name, 'will return harvested energy to room', closest_room,
                'from room', creep.room.name);
    creep.memory.return_room = closest_room;
    delete creep.memory.needs_return_room;
}

function run(creep) {
    if (creep.spawning) {
        return;
    }
    
    initialize(creep);
    if (creep.memory.needs_return_room && creep.room.name == creep.memory.target_room) {
        setup_return_room(creep);
    }

    c.retreat_from_enemies(creep, creep.memory.target_room, deliver) ||
        c.harvest_or_act(creep, harvest, deliver, null, null);
}

module.exports = {

    run,
    spawn_body,
    num_desired,

};
