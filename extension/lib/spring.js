// Пружинная физика для анимаций «как капля».
//
// В отличие от обычных анимаций с фиксированной длительностью, пружина помнит скорость:
// если цель меняется посреди движения, форма плавно меняет направление без рывка,
// а в конце слегка «перелетает» и успокаивается — как жидкость.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

export class Spring {
    /**
     * @param {number} value начальное значение
     * @param {object} params stiffness — жёсткость, damping — затухание, mass — масса
     */
    constructor(value, {stiffness = 300, damping = 26, mass = 1} = {}) {
        this.value = value;
        this.target = value;
        this.velocity = 0;
        this.stiffness = stiffness;
        this.damping = damping;
        this.mass = mass;
    }

    step(dt) {
        // полунеявный метод Эйлера с мелким шагом — устойчив при любом FPS
        let rest = Math.min(dt, 0.064);
        while (rest > 0) {
            const h = Math.min(rest, 1 / 480);
            const force = -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
            this.velocity += (force / this.mass) * h;
            this.value += this.velocity * h;
            rest -= h;
        }
        if (this.settled)
            this.snap();
    }

    get settled() {
        return Math.abs(this.value - this.target) < 0.05 && Math.abs(this.velocity) < 0.05;
    }

    snap() {
        this.value = this.target;
        this.velocity = 0;
    }
}

/**
 * Покадровый «двигатель»: вызывает onFrame(dt) синхронно с отрисовкой экрана,
 * пока тот возвращает true, и сам засыпает, когда всё успокоилось (не тратит CPU в покое).
 */
export class Animator {
    constructor(actor, onFrame) {
        this._actor = actor;
        this._onFrame = onFrame;
        this._timeline = null;
        this._last = 0;
    }

    start() {
        // таймлайн создаётся, когда актёр уже на сцене (он берёт часы кадров у монитора)
        if (!this._timeline) {
            if (!this._actor.get_stage())
                return;
            this._timeline = new Clutter.Timeline({actor: this._actor, duration: 1000, repeat_count: -1});
            this._timeline.connect('new-frame', () => this._tick());
        }
        if (this._timeline.is_playing())
            return;
        this._last = GLib.get_monotonic_time();
        this._timeline.start();
    }

    _tick() {
        const now = GLib.get_monotonic_time();
        const dt = Math.max(0, (now - this._last) / 1e6);
        this._last = now;
        if (!this._onFrame(dt))
            this._timeline?.stop();
    }

    destroy() {
        this._timeline?.stop();
        this._timeline = null;
        this._actor = null;
    }
}
