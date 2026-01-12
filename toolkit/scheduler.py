import torch
from typing import Optional
from diffusers.optimization import (
    SchedulerType, 
    TYPE_TO_SCHEDULER_FUNCTION, 
    get_constant_schedule_with_warmup,
    get_cosine_schedule_with_warmup,
    get_linear_schedule_with_warmup,
    get_cosine_with_hard_restarts_schedule_with_warmup
)


def get_lr_scheduler(
        name: Optional[str],
        optimizer: torch.optim.Optimizer,
        **kwargs,
):
    # Extract common parameters
    num_warmup_steps = kwargs.pop('num_warmup_steps', 0)
    num_training_steps = kwargs.pop('total_iters', None)
    num_cycles = kwargs.pop('num_cycles', 1)
    
    # Cleaning up kwargs for pytorch schedulers
    # These might be passed but not used by all
    if 'step_size' not in kwargs:
        kwargs.pop('step_size', None)
    if 'gamma' not in kwargs:
        kwargs.pop('gamma', None)

    if name == "cosine":
        return get_cosine_schedule_with_warmup(
            optimizer, 
            num_warmup_steps=num_warmup_steps, 
            num_training_steps=num_training_steps, 
            num_cycles=num_cycles if num_cycles is not None else 0.5
        )
    elif name == "cosine_with_restarts":
        return get_cosine_with_hard_restarts_schedule_with_warmup(
            optimizer, 
            num_warmup_steps=num_warmup_steps, 
            num_training_steps=num_training_steps, 
            num_cycles=num_cycles if num_cycles is not None else 1
        )
    elif name == "step":
        # StepLR needs step_size and gamma. They should be in kwargs if passed from UI.
        # But we need to make sure we don't pass extra stuff.
        # kwargs already popped warmup, total_iters, num_cycles.
        return torch.optim.lr_scheduler.StepLR(
            optimizer, **kwargs
        )
    elif name == "constant":
        if 'factor' not in kwargs:
            kwargs['factor'] = 1.0

        return torch.optim.lr_scheduler.ConstantLR(optimizer, **kwargs)
    elif name == "linear":
        return get_linear_schedule_with_warmup(
            optimizer,
            num_warmup_steps=num_warmup_steps,
            num_training_steps=num_training_steps
        )
    elif name == 'constant_with_warmup':
        # see if num_warmup_steps is in kwargs
        if num_warmup_steps is None:
            print(f"WARNING: num_warmup_steps not in kwargs. Using default value of 1000")
            num_warmup_steps = 1000
        return get_constant_schedule_with_warmup(
            optimizer, 
            num_warmup_steps=num_warmup_steps
        )
    else:
        # try to use a diffusers scheduler
        print(f"Trying to use diffusers scheduler {name}")
        try:
            name = SchedulerType(name)
            schedule_func = TYPE_TO_SCHEDULER_FUNCTION[name]
            return schedule_func(optimizer, **kwargs)
        except Exception as e:
            print(e)
            pass
        raise ValueError(
            "Scheduler must be cosine, cosine_with_restarts, step, linear or constant"
        )
